import type { WorkspaceEvent, WorkspaceSnapshot } from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { toWorkspaceEvents } from "../projector";
import { projectWorkspaceEvent } from "./projection";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "STORE"
);

const MAX_DROPPED_WARNING_KEYS = 256;
const DELTA_BATCH_WINDOW_MS = 50;
const MAX_DELTA_BATCH_EVENTS = 256;
const MAX_DELTA_BATCH_CHARS = 256 * 1024;
export const AGENT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const AGENT_RECEIPT_MAX_ROWS = 100_000;
const RECEIPT_PRUNE_INTERVAL = 256;

interface AgentReceipt {
  id: string;
  ts: number;
}

interface PendingDelta<TCommit> {
  event: NormalizedAgentEvent;
  reject: (error: unknown) => void;
  resolve: (commit: TCommit | null) => void;
}

type StepDeltaWorkspaceEvent = Extract<
  WorkspaceEvent,
  { type: "step.delta_appended" }
>;

interface DeltaBatchEntry {
  chunks: string[];
  event: StepDeltaWorkspaceEvent;
  timestamp: number;
}

interface AgentEventProcessorOptions<TCommit> {
  commit(
    events: WorkspaceEvent[],
    boardId: string | null,
    receipts?: AgentReceipt | AgentReceipt[]
  ): TCommit;
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  getSnapshot(): WorkspaceSnapshot;
  hasReceipt(id: string): boolean;
  isClosing(): boolean;
  persistReceipts(receipts: AgentReceipt[]): void;
  pruneReceipts(cutoff: number, maxRows: number): void;
}

export class WorkspaceAgentEventProcessor<TCommit> {
  readonly #options: AgentEventProcessorOptions<TCommit>;
  readonly #droppedWarnings = new Map<string, number>();
  #eventTail: Promise<void> = Promise.resolve();
  #pendingDeltas: PendingDelta<TCommit>[] = [];
  #pendingDeltaChars = 0;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #receiptsSincePrune = 0;

  constructor(options: AgentEventProcessorOptions<TCommit>) {
    this.#options = options;
  }

  apply(agentEvent: NormalizedAgentEvent): Promise<TCommit | null> {
    if (!agentEvent.sessionID) {
      return Promise.resolve(null);
    }
    if (this.#options.isClosing()) {
      return Promise.reject(new Error("workspace store is closing or closed"));
    }
    if (typeof agentEvent.delta === "string") {
      return this.#queueDelta(agentEvent);
    }

    this.flushPendingDeltas();
    return this.#queueAgentWork(() =>
      Promise.resolve(this.#applyEventToStore(agentEvent))
    );
  }

  flushPendingDeltas(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#pendingDeltas.length === 0) {
      return;
    }

    const pending = this.#pendingDeltas;
    this.#pendingDeltas = [];
    this.#pendingDeltaChars = 0;
    const commit = this.#queueAgentWork(() =>
      Promise.resolve(this.#applyDeltaBatch(pending.map(({ event }) => event)))
    );
    commit.then(
      (value) => {
        for (const item of pending) {
          item.resolve(value);
        }
      },
      (error: unknown) => {
        for (const item of pending) {
          item.reject(error);
        }
      }
    );
  }

  waitForIdle(): Promise<void> {
    return this.#eventTail;
  }

  #queueDelta(event: NormalizedAgentEvent): Promise<TCommit | null> {
    return new Promise((resolve, reject) => {
      this.#pendingDeltas.push({ event, reject, resolve });
      this.#pendingDeltaChars += event.delta?.length ?? 0;

      if (
        this.#pendingDeltas.length >= MAX_DELTA_BATCH_EVENTS ||
        this.#pendingDeltaChars >= MAX_DELTA_BATCH_CHARS
      ) {
        this.flushPendingDeltas();
        return;
      }

      if (this.#flushTimer === null) {
        this.#flushTimer = setTimeout(() => {
          this.#flushTimer = null;
          this.flushPendingDeltas();
        }, DELTA_BATCH_WINDOW_MS);
        this.#flushTimer.unref?.();
      }
    });
  }

  #queueAgentWork<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#eventTail.then(() => this.#options.enqueue(work));
    this.#eventTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #applyDeltaBatch(agentEvents: NormalizedAgentEvent[]): TCommit | null {
    const receipts = new Map<string, AgentReceipt>();
    const deltas = new Map<string, DeltaBatchEntry>();

    for (const agentEvent of agentEvents) {
      this.#collectDelta(agentEvent, receipts, deltas);
    }

    const events = [...deltas.values()].map(({ event, chunks, timestamp }) => ({
      ...event,
      delta: chunks.join(""),
      ts: timestamp,
    }));
    const persistedReceipts = [...receipts.values()];
    if (events.length === 0) {
      this.#persistReceipts(persistedReceipts);
      return null;
    }

    const boardIds = new Set(events.map((event) => event.boardId));
    const boardId = boardIds.size === 1 ? (events[0]?.boardId ?? null) : null;
    const commit = this.#options.commit(events, boardId, persistedReceipts);
    this.#pruneReceipts(persistedReceipts.length);
    return commit;
  }

  #collectDelta(
    agentEvent: NormalizedAgentEvent,
    receipts: Map<string, AgentReceipt>,
    deltas: Map<string, DeltaBatchEntry>
  ): void {
    const sessionId = agentEvent.sessionID;
    if (!sessionId) {
      return;
    }

    const board = this.#options
      .getSnapshot()
      .boards.find((entry) => entry.session.sessionId === sessionId);
    if (!board) {
      return;
    }

    const receipt = this.#createReceipt(board.boardId, sessionId, agentEvent);
    if (receipt && this.#hasReceipt(receipt, receipts)) {
      return;
    }

    const converted = toWorkspaceEvents(agentEvent, {
      boardId: board.boardId,
      taskId: board.session.currentTaskId ?? "",
    });
    const delta = converted.find(
      (event): event is StepDeltaWorkspaceEvent =>
        event.type === "step.delta_appended"
    );
    if (!delta || delta.taskId === "") {
      if (converted.length > 0) {
        this.#warnDroppedOnce(board.boardId, agentEvent);
      }
      this.#recordReceipt(receipt, receipts);
      return;
    }

    const key = JSON.stringify([delta.boardId, delta.taskId, delta.stepId]);
    const existing = deltas.get(key);
    if (existing) {
      existing.chunks.push(delta.delta);
      existing.timestamp = delta.ts;
    } else {
      deltas.set(key, {
        event: delta,
        chunks: [delta.delta],
        timestamp: delta.ts,
      });
    }
    this.#recordReceipt(receipt, receipts);
  }

  #createReceipt(
    boardId: string,
    sessionId: string,
    event: NormalizedAgentEvent
  ): AgentReceipt | undefined {
    if (!event.sourceEventId) {
      return undefined;
    }
    return {
      id: JSON.stringify([boardId, sessionId, event.sourceEventId]),
      ts: Date.now(),
    };
  }

  #hasReceipt(receipt: AgentReceipt, batchReceipts: Map<string, AgentReceipt>) {
    return (
      batchReceipts.has(receipt.id) || this.#options.hasReceipt(receipt.id)
    );
  }

  #recordReceipt(
    receipt: AgentReceipt | undefined,
    receipts: Map<string, AgentReceipt>
  ): void {
    if (receipt) {
      receipts.set(receipt.id, receipt);
    }
  }

  #applyEventToStore(agentEvent: NormalizedAgentEvent): TCommit | null {
    const snapshot = this.#options.getSnapshot();
    const board = snapshot.boards.find(
      (entry) => entry.session.sessionId === agentEvent.sessionID
    );
    if (!board) {
      return null;
    }

    const receipt = this.#createReceipt(
      board.boardId,
      agentEvent.sessionID ?? "",
      agentEvent
    );
    if (receipt && this.#options.hasReceipt(receipt.id)) {
      return null;
    }

    const converted = toWorkspaceEvents(agentEvent, {
      boardId: board.boardId,
      taskId: board.session.currentTaskId ?? "",
    });
    const events = converted.filter(
      (event) => !("taskId" in event) || event.taskId !== ""
    );
    if (events.length === 0) {
      if (converted.length > 0) {
        this.#warnDroppedOnce(board.boardId, agentEvent);
        this.#persistReceipts(receipt ? [receipt] : []);
      }
      return null;
    }

    let projected = snapshot;
    for (const event of events) {
      projected = projectWorkspaceEvent(projected, event);
    }
    if (projected === snapshot) {
      this.#persistReceipts(receipt ? [receipt] : []);
      return null;
    }

    const commit = this.#options.commit(events, board.boardId, receipt);
    if (receipt) {
      this.#pruneReceipts();
    }
    return commit;
  }

  #persistReceipts(receipts: AgentReceipt[]): void {
    if (receipts.length === 0) {
      return;
    }
    this.#options.persistReceipts(receipts);
    this.#pruneReceipts(receipts.length);
  }

  #pruneReceipts(count = 1): void {
    this.#receiptsSincePrune += count;
    if (this.#receiptsSincePrune < RECEIPT_PRUNE_INTERVAL) {
      return;
    }
    this.#receiptsSincePrune = 0;
    this.#options.pruneReceipts(
      Date.now() - AGENT_RECEIPT_RETENTION_MS,
      AGENT_RECEIPT_MAX_ROWS
    );
  }

  #warnDroppedOnce(boardId: string, agentEvent: NormalizedAgentEvent): void {
    if (this.#droppedWarnings.size > MAX_DROPPED_WARNING_KEYS) {
      this.#droppedWarnings.clear();
    }

    const key = `${boardId}:${agentEvent.sessionID ?? "unknown"}`;
    const seen = this.#droppedWarnings.get(key) ?? 0;
    this.#droppedWarnings.set(key, seen + 1);
    if (seen > 0) {
      return;
    }

    logger.warn("agent-event-dropped-no-current-task", {
      agentEventType: agentEvent.type,
      boardId,
      note: "repeats for this board and session are counted, not logged",
      sessionID: agentEvent.sessionID,
    });
  }
}
