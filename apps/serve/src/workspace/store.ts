// biome-ignore-all lint/suspicious/useAwait: every public write returns the serial queue's promise; async is the contract callers rely on

import { constants as fsConstants } from "node:fs";
import { access, copyFile, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyEventToBoard,
  type BoardSeed,
  type WorkspaceBoard,
  type WorkspaceEvent,
  type WorkspaceHistoryEntry,
  type WorkspaceMutation,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotInput,
  workspaceBoardSchema,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { z } from "zod";
import { RepositoryRegistry } from "../projects/repository-registry";
import {
  ChorusDatabase,
  type MetaChange,
  type PushSubscriptionRow,
  type StoredEvent,
  type StoredPushSubscription,
} from "./db";
import { attachSessionToBoard, toWorkspaceEvents } from "./projector";
import {
  DEFAULT_RETENTION_DAYS,
  isOverSizeCap,
  MUTATION_ID_RETENTION_MS,
  type RetentionOptions,
  retentionCutoff,
  shouldSnapshot,
  stripTerminalRunDetails,
} from "./retention";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "STORE"
);

const SNAPSHOT_BLOB_VERSION = 1;

/**
 * Result of a committed mutation or agent event.
 *
 * Pre-implementation decision #1 specified `{ boardId, event }`. This carries an
 * `events` array instead because one agent event legitimately expands into
 * several domain events (a completed tool call appends a step *and* moves the
 * card). Collapsing that to a single event would either drop the step or
 * require synthesising a fake one. Client mutations are still exactly one
 * event — enforced by `mutation-map.test.ts` and asserted here at runtime.
 */
/** One log entry, decoded, for replay and diagnostics. */
export interface SequencedRecord {
  boardId: string | null;
  event: WorkspaceEvent;
  seq: number;
}

export interface StoreCommit {
  boardId: string | null;
  /** Appended events, oldest first. Length 1 for every client mutation. */
  events: WorkspaceEvent[];
  firstSeq: number;
  lastSeq: number;
}

/** Beyond this many distinct boards/sessions, the drop-warning map resets. */
const MAX_DROPPED_WARNING_KEYS = 256;

const BOARD_X_OFFSET = 180;
const BOARD_Y_OFFSET = 120;
const BOARD_X_START = 120;
const BOARD_Y_START = 120;

function createHistoryId(board: Pick<WorkspaceBoard, "repo">): string {
  return board.repo.projectId ?? board.repo.worktree ?? board.repo.directory;
}

function createHistoryEntry(board: WorkspaceBoard): WorkspaceHistoryEntry {
  return {
    id: createHistoryId(board),
    title: board.title,
    lastOpenedAt: Date.now(),
    repo: board.repo,
  };
}

function sortHistory(
  entries: WorkspaceHistoryEntry[]
): WorkspaceHistoryEntry[] {
  return [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

function createBoardFromSeed(seed: BoardSeed, index: number): WorkspaceBoard {
  // Parse so zod defaults (repo.sandboxes, board.reviewMode) are applied here
  // rather than appearing only after a reload. In-memory state has to be the
  // same shape a rehydrated snapshot produces, or replay-equality never holds.
  return workspaceBoardSchema.parse({
    boardId: crypto.randomUUID(),
    title: seed.title,
    repo: seed.repo,
    position: {
      x: BOARD_X_START + index * BOARD_X_OFFSET,
      y: BOARD_Y_START + index * BOARD_Y_OFFSET,
    },
    columns: { queue: [], in_progress: [], approve: [], done: [] },
    reviewMode: "auto",
    modelSelection: null,
    session: { state: "uninitialized" },
  });
}

/**
 * Drops `undefined`-valued keys so in-memory state matches what a snapshot
 * round-trip yields. Without this, a field explicitly set to `undefined`
 * (e.g. clearing `session.errorMessage`) survives in memory but disappears on
 * reload, and replay-equality assertions fail on a semantic no-op.
 */
function canonical<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const EMPTY_PREFERENCES: WorkspaceSnapshotInput["preferences"] = {
  boardViewMode: "relaxed",
  composerHintDismissed: false,
  recentlyUsedModels: [],
  speechVoiceId: null,
};

interface PersistedBlob {
  snapshot: WorkspaceSnapshot;
  v: number;
}

/**
 * Single-writer, append-only workspace store backed by SQLite (spec §5).
 *
 * Three invariants this class exists to hold:
 *
 * 1. **Commit then swap.** A candidate state is computed, appended inside an
 *    IMMEDIATE transaction, and only assigned to memory once the write
 *    succeeds. A failed INSERT leaves memory untouched, so in-memory state can
 *    never run ahead of the durable log. (The pre-Phase-2 store wrote the whole
 *    snapshot to JSON and silently reset to empty on a parse failure.)
 * 2. **One writer.** Every state change chains onto a single promise, so there
 *    is no read-modify-write race between mutations, agent events, and session
 *    updates. `Promise.all` over state-mutating work is never correct here.
 * 3. **One projection path.** Live application and boot replay both go through
 *    `#project`, so a state reconstructed from the log is identical to one built
 *    live — which is only true because the shared projector is pure.
 */
/**
 * What the store needs from worktree provisioning (plan P6 task 2).
 *
 * Declared structurally rather than imported from `projects/worktree-manager` so
 * the store keeps no git dependency and no coupling to the module that happens to
 * implement it. `WorktreeManager` satisfies it as-is.
 */
export interface WorktreeProvisioner {
  assertRemovable?(repoDirectory: string, boardId: string): Promise<void>;
  /** Creates (or adopts) the worktree for `boardId` and resolves to its path. */
  ensureWorktree(
    repoDirectory: string,
    boardId: string,
    branch?: string
  ): Promise<string>;
  /**
   * Whether a *new* board for this repo needs its own checkout.
   *
   * Called with the boards that already exist, so the first board for a repo is
   * never given a worktree.
   */
  needsWorktree(
    boards: ReadonlyArray<{ repo: { directory: string } }>,
    repoDirectory: string
  ): boolean;
  /** Optional: removes a board's worktree when the board is removed. */
  removeWorktree?(repoDirectory: string, boardId: string): Promise<void>;
}

const WORKTREE_CLEANUP_PREFIX = "worktree-cleanup:v1:";
const WORKTREE_PROVISION_PREFIX = "worktree-provision:v1:";
const AGENT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_RECEIPT_MAX_ROWS = 100_000;
const AGENT_RECEIPT_PRUNE_INTERVAL = 256;
const worktreeCleanupSchema = z.object({
  boardId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  repoDirectory: z.string().min(1),
});

type WorktreeCleanup = z.infer<typeof worktreeCleanupSchema>;

interface ProducedMutation {
  boardId: string | null;
  cleanup?: WorktreeCleanup;
  events: WorkspaceEvent[];
  metaChanges?: MetaChange[];
}

export class WorkspaceStore {
  readonly #db: ChorusDatabase;
  readonly #options: Required<RetentionOptions>;
  readonly #queue: { promise: Promise<void> } = { promise: Promise.resolve() };
  /**
   * Optional worktree provisioning for `board.create` (plan P6 task 2).
   *
   * Injected rather than constructed here so the store keeps no git dependency,
   * and so tests can supply a stub. When absent, board creation behaves exactly
   * as before: no worktree, and every board shares the repo's primary checkout.
   */
  readonly #worktreeProvisioner: WorktreeProvisioner | undefined;
  readonly #repositoryRegistry: RepositoryRegistry | undefined;
  readonly #restorePersistedRepositoryRoots: boolean;

  /** Subscribers notified once per commit, after memory is swapped. */
  readonly #commitListeners = new Set<(commit: StoreCommit) => void>();
  #closing = false;
  #closePromise: Promise<void> | null = null;

  #snapshot: WorkspaceSnapshot = {
    boards: [],
    preferences: EMPTY_PREFERENCES,
    previousWorkspaces: [],
    revision: 0,
    selectedBoardId: null,
  };

  /** Events appended since the last snapshot, for the N-event snapshot trigger. */
  #eventsSinceSnapshot = 0;
  #agentReceiptsSincePrune = 0;

  constructor(
    dataDir: string,
    options: RetentionOptions & {
      worktreeProvisioner?: WorktreeProvisioner;
      repositoryRegistry?: RepositoryRegistry;
      restorePersistedRepositoryRoots?: boolean;
    } = {}
  ) {
    this.#worktreeProvisioner = options.worktreeProvisioner;
    this.#repositoryRegistry = options.repositoryRegistry;
    this.#restorePersistedRepositoryRoots =
      options.restorePersistedRepositoryRoots !== false;
    this.#db = new ChorusDatabase(dataDir);
    this.#options = {
      dbSizeCapMb: options.dbSizeCapMb ?? 512,
      retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
      snapshotInterval: options.snapshotInterval ?? 1000,
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Rehydrates from the newest snapshot plus the tail of the log, then prunes
   * stale idempotency keys.
   *
   * `legacySnapshotPath` triggers the one-shot `workspace.json` import. Corrupt
   * legacy JSON throws with the path rather than falling back to an empty
   * workspace — silently starting empty would look identical to data loss.
   */
  async load(legacySnapshotPath?: string): Promise<void> {
    this.#db.pruneMutationIds(Date.now() - MUTATION_ID_RETENTION_MS);
    this.#db.pruneAgentReceipts(
      Date.now() - AGENT_RECEIPT_RETENTION_MS,
      AGENT_RECEIPT_MAX_ROWS
    );

    if (this.#repositoryRegistry && this.#restorePersistedRepositoryRoots) {
      await this.#repositoryRegistry.restorePersistedRoots(
        this.#db.getMeta(RepositoryRegistry.persistedRootsKey)
      );
    }

    const snapshot = this.#db.latestSnapshot();

    if (snapshot) {
      this.#snapshot = this.#parseBlob(snapshot.blob);
      const tail = this.#db.readEventsSince(snapshot.seq);
      for (const stored of tail) {
        this.#snapshot = this.#project(this.#snapshot, this.#decode(stored));
      }
      this.#eventsSinceSnapshot = tail.length;
      logger.info("workspace-rehydrated", {
        fromSnapshotSeq: snapshot.seq,
        replayed: tail.length,
        headSeq: this.#db.headSeq(),
      });
      await this.#reconcileWorktreeIntents();
      return;
    }

    const imported = legacySnapshotPath
      ? await this.#importLegacySnapshot(legacySnapshotPath)
      : null;

    if (imported) {
      this.#snapshot = imported;
      logger.info("workspace-imported-legacy-snapshot", {
        boards: imported.boards.length,
      });
    }

    await this.writeSnapshot();
    if (imported && legacySnapshotPath) {
      await this.#parkLegacySnapshot(legacySnapshotPath);
    }
    await this.#reconcileWorktreeIntents();
  }

  /** Resolves when every queued state change has committed. */
  async drain(): Promise<void> {
    await this.#enqueue(async () => undefined);
  }

  /**
   * Order matters (spec §5): drain the queue, write a final snapshot so boot
   * does not replay a long tail, then fold the WAL back so a cold copy of
   * `chorus.db` is a complete backup.
   */
  async close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closing = true;
    const closePromise = this.#queue.promise.then(() => {
      this.#writeSnapshotNow();
      this.#db.checkpointTruncate();
      this.#db.close();
    });
    this.#queue.promise = closePromise.then(
      () => undefined,
      () => undefined
    );
    this.#closePromise = closePromise;
    return closePromise;
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  getSnapshot(): WorkspaceSnapshot {
    return structuredClone(this.#snapshot);
  }

  getBoard(boardId: string): WorkspaceBoard | undefined {
    return this.#snapshot.boards.find((board) => board.boardId === boardId);
  }

  /** Register a checkout selected by the trusted host folder picker. */
  async registerPickedRepository(directory: string): Promise<string> {
    return this.#enqueue(async () => {
      const registry = this.#repositoryRegistry;
      if (!registry) {
        throw new Error("repository onboarding is not configured");
      }

      const canonical = await registry.validatePickedRoot(directory);
      const roots = new Set([...registry.roots, canonical]);
      this.#db.setMeta(
        RepositoryRegistry.persistedRootsKey,
        JSON.stringify([...roots].sort())
      );
      registry.addValidatedRoot(canonical);
      return canonical;
    });
  }

  /**
   * The board a session belongs to, by the session id the engine issued.
   *
   * Reverse of the lookup `applyAgentEvent` does. Used to resolve the working
   * directory for follow-up commands — an approval reply, an abort, a redirect —
   * which otherwise fall back to the directory serve was started in rather than
   * the board's own checkout.
   */
  getBoardBySessionId(sessionId: string): WorkspaceBoard | undefined {
    if (!sessionId) {
      return undefined;
    }
    return this.#snapshot.boards.find(
      (board) => board.session.sessionId === sessionId
    );
  }

  headSeq(): number {
    return this.#db.headSeq();
  }

  /**
   * Oldest sequence that can still be replayed — the sequence of the newest
   * snapshot. Events at or below it have been pruned, so a client resuming from
   * before this point cannot be served a complete gap and must get a snapshot
   * instead.
   */
  replayFloorSeq(): number {
    return this.#db.latestSnapshot()?.seq ?? 0;
  }

  /**
   * Decoded events strictly after `seq`, oldest first.
   *
   * This is the read side of the resume path: a reconnecting client sends the
   * last sequence it saw and gets back exactly the gap, so it never has to
   * re-fetch a whole snapshot for a one-event miss. Decoding failures throw
   * rather than yielding a partial list — a client must not be handed a
   * silently truncated replay.
   */
  eventsSince(seq: number, limit?: number): SequencedRecord[] {
    const rows = this.#db.readEventsSince(
      seq,
      limit ?? Number.MAX_SAFE_INTEGER
    );

    return rows.map((row) => ({
      boardId: row.boardId,
      event: this.#decode(row),
      seq: row.seq,
    }));
  }

  /** Path of the SQLite file, for the restore/export runbook. */
  get databasePath(): string {
    return this.#db.path;
  }

  async persistMetaChanges(changes: MetaChange[]): Promise<void> {
    await this.#enqueue(async () => {
      this.#db.writeMetaChanges(changes);
    });
  }

  getMeta(key: string): string | null {
    return this.#db.getMeta(key);
  }

  listPushSubscriptions(deviceId?: string): StoredPushSubscription[] {
    return this.#db.listPushSubscriptions(deviceId);
  }

  getPushSubscription(endpoint: string): StoredPushSubscription | null {
    return this.#db.pushSubscription(endpoint);
  }

  async upsertPushSubscription(
    subscription: PushSubscriptionRow,
    maxPerDevice = 4
  ): Promise<"stored" | "owned-by-another-device" | "limit-reached"> {
    return this.#enqueue(async () =>
      this.#db.upsertPushSubscription(subscription, maxPerDevice)
    );
  }

  async deletePushSubscription(
    endpoint: string,
    deviceId: string
  ): Promise<boolean> {
    return this.#enqueue(async () =>
      this.#db.deletePushSubscription(endpoint, deviceId)
    );
  }

  async deletePushSubscriptionIfMatches(
    subscription: StoredPushSubscription
  ): Promise<boolean> {
    return this.#enqueue(async () =>
      this.#db.deletePushSubscriptionIfMatches(subscription)
    );
  }

  async deleteDevicePushSubscriptions(deviceId: string): Promise<number> {
    return this.#enqueue(async () =>
      this.#db.deleteDevicePushSubscriptions(deviceId)
    );
  }

  async resolvePendingApproval(
    sessionId: string,
    requestId: string
  ): Promise<boolean> {
    return this.#enqueue(async () => {
      const board = this.#snapshot.boards.find(
        (entry) => entry.session.sessionId === sessionId
      );
      if (!board) {
        return false;
      }
      const task = Object.values(board.columns)
        .flat()
        .find(
          (entry) =>
            entry.pendingApprovals?.some(
              (request) => request.requestId === requestId
            ) || entry.pendingApproval?.requestId === requestId
        );
      if (!task) {
        return false;
      }
      this.#commit(
        [
          {
            boardId: board.boardId,
            requestId,
            taskId: task.id,
            ts: Date.now(),
            type: "card.approval_resolved",
          },
        ],
        board.boardId,
        null
      );
      return true;
    });
  }

  /**
   * The `meta` key/value table.
   *
   * Exposed so the auth layer can persist single-use WebSocket tickets (spec
   * §6.2) without reaching into SQLite itself. The store owns the connection and
   * stays the only writer; these are the same operations `mut:` idempotency keys
   * use, so ticket rows and mutation rows share one durability story.
   */
  get meta(): {
    deleteMeta(key: string): void;
    entriesWithPrefix(prefix: string): [string, string][];
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
  } {
    return {
      deleteMeta: (key: string) => this.#db.deleteMeta(key),
      entriesWithPrefix: (prefix: string) => this.#db.entriesWithPrefix(prefix),
      getMeta: (key: string) => this.#db.getMeta(key),
      setMeta: (key: string, value: string) => this.#db.setMeta(key, value),
    };
  }

  exportTo(destination: string): void {
    this.#db.exportTo(destination);
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /**
   * Applies one client mutation as exactly one event.
   *
   * Returns null when the mutation was already applied (idempotent replay of a
   * retried request) or when it addressed nothing. Callers read `getSnapshot()`
   * in that case — there is no new state to broadcast.
   */
  async applyMutation(
    mutation: WorkspaceMutation
  ): Promise<StoreCommit | null> {
    return this.#enqueue(() => this.#applyMutationInQueue(mutation));
  }

  async #applyMutationInQueue(
    mutation: WorkspaceMutation
  ): Promise<StoreCommit | null> {
    if (this.#db.mutationIdSeen(mutation.mutationId)) {
      return null;
    }

    const now = Date.now();
    const produced = await this.#mutationToEvents(mutation, now);
    if (!produced) {
      return null;
    }
    if (produced.events.length !== 1) {
      throw new Error(
        `mutation ${mutation.type} produced ${produced.events.length} events; the 1-mutation-to-1-event contract requires exactly 1`
      );
    }

    const metaChanges = [...(produced.metaChanges ?? [])];
    if (produced.cleanup) {
      metaChanges.push({
        key: `${WORKTREE_CLEANUP_PREFIX}${produced.cleanup.boardId}`,
        value: JSON.stringify(produced.cleanup),
      });
    }

    let commit: StoreCommit;
    try {
      commit = this.#commit(
        produced.events,
        produced.boardId,
        { id: mutation.mutationId, ts: now },
        metaChanges
      );
    } catch (error) {
      await this.#compensateProvisionedWorktree(produced.events);
      throw error;
    }

    if (produced.cleanup) {
      await this.#finishWorktreeCleanup(
        produced.cleanup,
        `${WORKTREE_CLEANUP_PREFIX}${produced.cleanup.boardId}`
      );
    }
    return commit;
  }

  async #compensateProvisionedWorktree(
    events: WorkspaceEvent[]
  ): Promise<void> {
    const created = events.find((event) => event.type === "board.created");
    if (created?.type !== "board.created") {
      return;
    }
    const key = `${WORKTREE_PROVISION_PREFIX}${created.board.boardId}`;
    const rawIntent = this.#db.getMeta(key);
    const intent = rawIntent ? this.#parseWorktreeIntent(rawIntent) : null;
    if (intent) {
      await this.#finishWorktreeCleanup(intent, key);
    }
  }

  /** Applies one normalized agent event, which may expand to several events. */
  async applyAgentEvent(
    agentEvent: NormalizedAgentEvent
  ): Promise<StoreCommit | null> {
    if (!agentEvent.sessionID) {
      return null;
    }

    return this.#enqueue(async () => this.#applyAgentEventToStore(agentEvent));
  }

  #applyAgentEventToStore(
    agentEvent: NormalizedAgentEvent
  ): StoreCommit | null {
    const board = this.#snapshot.boards.find(
      (entry) => entry.session.sessionId === agentEvent.sessionID
    );
    if (!board) {
      return null;
    }

    const receipt = agentEvent.sourceEventId
      ? {
          id: JSON.stringify([
            board.boardId,
            agentEvent.sessionID,
            agentEvent.sourceEventId,
          ]),
          ts: Date.now(),
        }
      : undefined;
    if (receipt && this.#db.hasAgentReceipt(receipt.id)) {
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
        this.#persistAgentReceipt(receipt);
      }
      return null;
    }

    let projected = this.#snapshot;
    for (const event of events) {
      projected = this.#project(projected, event);
    }
    if (projected === this.#snapshot) {
      this.#persistAgentReceipt(receipt);
      return null;
    }

    const commit = this.#commit(events, board.boardId, null, [], receipt);
    if (receipt) {
      this.#pruneAgentReceiptsPeriodically();
    }
    return commit;
  }

  #persistAgentReceipt(receipt: { id: string; ts: number } | undefined): void {
    if (!receipt) {
      return;
    }
    this.#db.appendEvents([], null, [], receipt);
    this.#pruneAgentReceiptsPeriodically();
  }

  #pruneAgentReceiptsPeriodically(): void {
    this.#agentReceiptsSincePrune += 1;
    if (this.#agentReceiptsSincePrune < AGENT_RECEIPT_PRUNE_INTERVAL) {
      return;
    }
    this.#agentReceiptsSincePrune = 0;
    this.#db.pruneAgentReceipts(
      Date.now() - AGENT_RECEIPT_RETENTION_MS,
      AGENT_RECEIPT_MAX_ROWS
    );
  }

  /**
   * Warns once per board and session about dropped agent events.
   *
   * A streamed delta carries no task id and arrives per token, so warning on every
   * one turned a single mis-bound session into thousands of identical lines and
   * buried everything else in the log. One line per (board, session) names the
   * condition; the count is kept so the scale is still visible.
   */
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

  /**
   * Boards that have already reported a dropped agent event.
   *
   * Bounded, because the purpose is to stop a runaway stream from flooding the
   * log and an unbounded map would replace one leak with another.
   */
  readonly #droppedWarnings = new Map<string, number>();

  /**
   * Commits already-built board events for one board.
   *
   * `applyMutation` is for client mutations and `applyAgentEvent` for normalized
   * stream events, which is a different shape. Neither can express "the server
   * decided a card now exists" — the event log needs that when a prompt is
   * queued, because `board.session.currentTaskId` is the only thing that lets
   * `applyAgentEvent` attach a task to subsequent agent events, and
   * `card.created` is the only projector branch that sets it
   * (`packages/contracts/src/projector.ts`).
   *
   * Enqueued and committed through `#commit` like every other write, so the
   * store stays the single emit path and the hub still learns about this from
   * `onCommit` rather than from a second broadcast.
   */
  async applyBoardEvents(
    boardId: string,
    events: WorkspaceEvent[]
  ): Promise<StoreCommit | null> {
    return this.applyBoardEventsIf(boardId, events, () => true);
  }

  /**
   * `applyBoardEvents`, but the decision to commit is made inside the queue.
   *
   * A caller that reads board state and then calls `applyBoardEvents` is doing a
   * check-then-act across the queue boundary, so two concurrent callers can both
   * see the same "not set yet" and both commit. Passing the condition down moves
   * the read and the write into the same queue entry, which is the same rule the
   * rest of the store follows.
   */
  async applyBoardEventsIf(
    boardId: string,
    events: WorkspaceEvent[],
    shouldCommit: (board: WorkspaceBoard) => boolean
  ): Promise<StoreCommit | null> {
    if (events.length === 0) {
      return null;
    }

    return this.#enqueue(async () => {
      const board = this.getBoard(boardId);
      if (!board) {
        return null;
      }

      // Board-scoped events have to address the board named here. `#commit` and
      // the projector both read `event.boardId`, so a mismatch would emit against
      // a board the caller did not name. Workspace-scoped events (preferences)
      // carry no board id and are passed through.
      if (
        events.some((event) => "boardId" in event && event.boardId !== boardId)
      ) {
        throw new Error(
          `applyBoardEvents received an event for a different board than ${boardId}`
        );
      }

      if (!shouldCommit(board)) {
        return null;
      }

      return this.#commit(events, boardId, null);
    });
  }

  /**
   * Session bookkeeping (attach, state transitions) is state-mutating work and
   * goes through the same queue as mutations — plan risk #5. A single unguarded
   * direct write here would reintroduce lost-update races.
   */
  async updateBoardSession(
    boardId: string,
    update: Partial<WorkspaceBoard["session"]>
  ): Promise<StoreCommit | null> {
    return this.#enqueue(async () => {
      const board = this.getBoard(boardId);
      if (!board) {
        return null;
      }

      const events: WorkspaceEvent[] = [];

      if (update.sessionId) {
        const attached = attachSessionToBoard(board, update.sessionId);
        const sessionEvent = diffSessionEvent(board, attached);
        if (sessionEvent) {
          events.push(sessionEvent);
        }
      }

      const patch = withoutKeys(update, ["sessionId"]);
      if (Object.keys(patch).length > 0) {
        events.push({
          type: "board.session_patched",
          boardId,
          ts: Date.now(),
          session: patch,
        });
      }

      if (events.length === 0) {
        return null;
      }

      return this.#commit(events, boardId, null);
    });
  }

  async updateBoardReviewMode(
    boardId: string,
    reviewMode: "manual" | "auto"
  ): Promise<StoreCommit | null> {
    return this.#enqueue(async () => {
      if (!this.getBoard(boardId)) {
        return null;
      }

      return this.#commit(
        [
          {
            type: "board.review_mode_set",
            boardId,
            ts: Date.now(),
            reviewMode,
          },
        ],
        boardId,
        null
      );
    });
  }

  /**
   * Writes a full-state snapshot and folds the covered events away. Also the
   * only place retention is applied, so both paths cannot diverge.
   */
  async writeSnapshot(): Promise<void> {
    await this.#enqueue(async () => {
      this.#writeSnapshotNow();
    });
  }

  /**
   * Boot-and-hourly retention pass: prune terminal-run detail, then snapshot so
   * the pruning is durable and the event tail stops growing.
   */
  async runRetention(): Promise<void> {
    await this.writeSnapshot();
    logger.info("workspace-retention-ran", {
      eventsRemaining: this.#db.eventCount(),
      headSeq: this.#db.headSeq(),
    });
  }

  /** Compacts the log if the file outgrew its cap. Safe to call on a timer. */
  async compactIfOversized(): Promise<boolean> {
    const oversized = isOverSizeCap(
      this.#db.dbSizeBytes(),
      this.#options.dbSizeCapMb
    );

    if (
      oversized ||
      shouldSnapshot(this.#eventsSinceSnapshot, this.#options.snapshotInterval)
    ) {
      await this.writeSnapshot();
    }

    return oversized;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Registers the single downstream emit path (spec §3: "Exactly one emit path
   * from store → WS hub").
   *
   * Every writer already funnels through `#commit`, so subscribing here covers
   * HTTP routes, the opencode bridge, the session watchdog, and the task
   * service without any of them knowing a hub exists — and without any of them
   * being able to forget to broadcast. Fires only after a successful write, so
   * a subscriber never sees a commit that was rolled back.
   *
   * Returns an unsubscribe function.
   */
  onCommit(listener: (commit: StoreCommit) => void): () => void {
    this.#commitListeners.add(listener);
    return () => {
      this.#commitListeners.delete(listener);
    };
  }

  #boardExists(boardId: string): boolean {
    return this.#snapshot.boards.some((board) => board.boardId === boardId);
  }

  /**
   * Translates one client mutation into exactly one event (plan Phase 1, task
   * 5). The table is `MUTATION_EVENT_MAP` in `@chorus/contracts`; this is the
   * store's half of that contract.
   *
   * `board.create` is the only case needing server-side generation — the board
   * id and layout position — so the event carries the whole constructed board
   * and replay stays a pure projection rather than re-running a generator.
   */
  /**
   * Gives a new board its own worktree when the repo is already spoken for.
   *
   * Runs inside the serial queue so the create is serialized against every other
   * mutation, and inside the board-create path so a failure aborts the whole
   * mutation rather than producing a second event and tripping the
   * 1-mutation-to-1-event assertion in `applyMutation`.
   */
  /**
   * Removes a board's worktree, if it had one of its own.
   *
   * A board on the repo's primary checkout has `worktree === directory`, and
   * removing that would delete the user's actual repository.
   */
  async #finishWorktreeCleanup(
    intent: WorktreeCleanup,
    intentKey: string
  ): Promise<void> {
    const provisioner = this.#worktreeProvisioner;
    if (!provisioner?.removeWorktree) {
      logger.warn("worktree-cleanup-unavailable", {
        boardId: intent.boardId,
      });
      return;
    }

    try {
      await provisioner.removeWorktree(intent.repoDirectory, intent.boardId);
      this.#db.deleteMeta(intentKey);
      logger.info("worktree-cleanup-complete", {
        boardId: intent.boardId,
      });
    } catch (error) {
      logger.warn("worktree-cleanup-pending", {
        boardId: intent.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #parseWorktreeIntent(raw: string): WorktreeCleanup | null {
    const parsed = worktreeCleanupSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async #reconcileWorktreeIntents(): Promise<void> {
    const snapshotBoardIds = new Set(
      this.#snapshot.boards.map((board) => board.boardId)
    );
    const records = [
      ...this.#db.entriesWithPrefix(WORKTREE_CLEANUP_PREFIX),
      ...this.#db.entriesWithPrefix(WORKTREE_PROVISION_PREFIX),
    ];

    for (const [key, raw] of records) {
      let intent: WorktreeCleanup | null;
      try {
        intent = this.#parseWorktreeIntent(raw);
      } catch {
        intent = null;
      }
      if (!intent) {
        logger.error("worktree-intent-invalid", undefined, { key });
        continue;
      }
      if (snapshotBoardIds.has(intent.boardId)) {
        this.#db.deleteMeta(key);
        continue;
      }
      await this.#finishWorktreeCleanup(intent, key);
    }
  }

  async #createBoard(
    seed: BoardSeed
  ): Promise<{ board: WorkspaceBoard; metaChanges?: MetaChange[] }> {
    const registry = this.#repositoryRegistry;
    const directory = registry
      ? await registry.validateCandidate(seed.repo.directory)
      : seed.repo.directory;
    const trustedSeed = registry
      ? {
          ...seed,
          repo: {
            branch: seed.repo.branch,
            directory,
            projectId: seed.repo.projectId,
            projectName: seed.repo.projectName,
            sandboxes: [],
            worktree: directory,
          },
        }
      : seed;
    const board = createBoardFromSeed(
      trustedSeed,
      this.#snapshot.boards.length
    );
    const provisioner = this.#worktreeProvisioner;
    if (
      !provisioner?.needsWorktree(this.#snapshot.boards, board.repo.directory)
    ) {
      return { board };
    }

    const intent: WorktreeCleanup = {
      boardId: board.boardId,
      createdAt: Date.now(),
      repoDirectory: board.repo.directory,
    };
    const intentKey = `${WORKTREE_PROVISION_PREFIX}${board.boardId}`;
    this.#db.setMeta(intentKey, JSON.stringify(intent));
    try {
      const worktree = await provisioner.ensureWorktree(
        board.repo.directory,
        board.boardId
      );
      return {
        board: { ...board, repo: { ...board.repo, worktree } },
        metaChanges: [{ key: intentKey, value: null }],
      };
    } catch (error) {
      await this.#finishWorktreeCleanup(intent, intentKey);
      throw error;
    }
  }

  #existingBoardMutation(
    boardId: string,
    event: WorkspaceEvent
  ): ProducedMutation | null {
    if (!this.#boardExists(boardId)) {
      return null;
    }
    return { boardId, events: [event] };
  }

  async #mutationToEvents(
    mutation: WorkspaceMutation,
    now: number
  ): Promise<ProducedMutation | null> {
    switch (mutation.type) {
      case "board.create": {
        const result = await this.#createBoard(mutation.payload.seed);
        const created = result.board;

        return {
          boardId: created.boardId,
          metaChanges: result.metaChanges,
          events: [
            {
              type: "board.created",
              boardId: created.boardId,
              board: created,
              ts: now,
            },
          ],
        };
      }

      case "board.remove": {
        const removed = this.getBoard(mutation.payload.boardId);
        if (!removed) {
          return null;
        }

        const provisioner = this.#worktreeProvisioner;
        const hasOwnedWorktree =
          removed.repo.worktree !== removed.repo.directory &&
          Boolean(provisioner?.removeWorktree);
        if (hasOwnedWorktree) {
          if (this.#repositoryRegistry) {
            await this.#repositoryRegistry.validateCandidate(
              removed.repo.directory
            );
            await this.#repositoryRegistry.validateAuthorizedCheckout(
              removed.repo.worktree ?? removed.repo.directory
            );
          }
          await provisioner?.assertRemovable?.(
            removed.repo.directory,
            removed.boardId
          );
        }

        return {
          boardId: mutation.payload.boardId,
          ...(hasOwnedWorktree
            ? {
                cleanup: {
                  boardId: removed.boardId,
                  createdAt: now,
                  repoDirectory: removed.repo.directory,
                },
              }
            : {}),
          events: [
            {
              type: "board.removed",
              boardId: mutation.payload.boardId,
              ts: now,
            },
          ],
        };
      }

      case "board.select":
        return {
          boardId: mutation.payload.boardId,
          events: [
            {
              type: "board.selected",
              boardId: mutation.payload.boardId,
              ts: now,
            },
          ],
        };

      case "board.move":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.moved",
          boardId: mutation.payload.boardId,
          ts: now,
          position: mutation.payload.position,
        });

      case "board.columns.replace":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.columns_replaced",
          boardId: mutation.payload.boardId,
          ts: now,
          columns: mutation.payload.columns,
        });

      case "board.session.patch":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.session_patched",
          boardId: mutation.payload.boardId,
          ts: now,
          session: mutation.payload.session,
        });

      case "board.model.set":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.model_set",
          boardId: mutation.payload.boardId,
          ts: now,
          model: mutation.payload.model,
        });

      case "board.review_mode.set":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.review_mode_set",
          boardId: mutation.payload.boardId,
          ts: now,
          reviewMode: mutation.payload.reviewMode,
        });

      case "board.task.plan.update":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.task_plan_updated",
          boardId: mutation.payload.boardId,
          ts: now,
          taskId: mutation.payload.taskId,
          plan: mutation.payload.plan,
          questions: mutation.payload.questions,
        });

      case "preference.recently_used_models.add":
        return {
          boardId: null,
          events: [
            {
              type: "preference.recent_model_added",
              ts: now,
              model: mutation.payload.model,
            },
          ],
        };

      case "preference.dismiss_composer_hint":
        return {
          boardId: null,
          events: [{ type: "preference.composer_hint_dismissed", ts: now }],
        };

      // Two mutations intentionally converge on one event: `set_voice` and
      // `speech_voice.set` are the same intent, and the pre-Phase-2 switch only
      // handled the latter — sending the former threw "Unsupported workspace
      // mutation type".
      case "preference.speech_voice.set":
        return {
          boardId: null,
          events: [
            {
              type: "preference.speech_voice_set",
              ts: now,
              voiceId: mutation.payload.voiceId,
            },
          ],
        };

      case "preference.set_voice":
        return {
          boardId: null,
          events: [
            {
              type: "preference.speech_voice_set",
              ts: now,
              voiceId: mutation.payload.voice,
            },
          ],
        };

      case "preference.board_view_mode.set":
        return {
          boardId: null,
          events: [
            {
              type: "preference.board_view_mode_set",
              ts: now,
              mode: mutation.payload.mode,
            },
          ],
        };

      default:
        throw new Error(
          `unhandled workspace mutation type: ${String(
            (mutation as { type: string }).type
          )}`
        );
    }
  }

  /**
   * The single serialization point. `this.#queue` is replaced with a promise
   * that never rejects, so one failed write cannot poison every later task —
   * each caller still observes its own rejection through the returned promise.
   */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new Error("workspace store is closing or closed"));
    }

    const result = this.#queue.promise.then(work);
    this.#queue.promise = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Appends events, then swaps memory. Order is the whole point: if the
   * transaction throws, `this.#snapshot` is never assigned and the in-memory
   * state still matches the last durable commit.
   */
  #commit(
    events: WorkspaceEvent[],
    boardId: string | null,
    mutationKey: { id: string; ts: number } | null,
    metaChanges: MetaChange[] = [],
    agentReceipt?: { id: string; ts: number }
  ): StoreCommit {
    let candidate = this.#snapshot;
    for (const event of events) {
      candidate = this.#project(candidate, event);
    }
    candidate = {
      ...candidate,
      revision: this.#snapshot.revision + 1,
    };

    const { firstSeq, lastSeq } = this.#db.appendEvents(
      events.map((event) => ({
        boardId: boardIdOf(event),
        payload: JSON.stringify(event),
        ts: event.ts,
        type: event.type,
      })),
      mutationKey,
      metaChanges,
      agentReceipt
    );

    this.#snapshot = candidate;
    this.#eventsSinceSnapshot += events.length;

    const commit = { boardId, events, firstSeq, lastSeq };

    // Post-commit, so a subscriber can never observe state the log rejected.
    //
    // Isolated on purpose. This runs inside the serial commit queue, and a
    // subscriber here is the websocket hub, which writes to sockets. A throw
    // would propagate out of a commit that is already durable and already
    // applied, so the caller would see `workspace-projection-failed` for a write
    // that in fact succeeded — a lie about the log, and the worst kind.
    for (const listener of this.#commitListeners) {
      try {
        listener(commit);
      } catch (error) {
        console.error("[store] commit listener failed:", error);
      }
    }

    if (
      shouldSnapshot(this.#eventsSinceSnapshot, this.#options.snapshotInterval)
    ) {
      try {
        this.#writeSnapshotNow();
      } catch (error) {
        // The append above is already durable. A maintenance failure must not
        // report that committed mutation as failed; keep the event tail intact
        // and try the snapshot again after more events arrive.
        logger.error(
          "workspace-snapshot-failed",
          error instanceof Error ? error : undefined
        );
      }
    }

    return commit;
  }

  #writeSnapshotNow(): void {
    const snapshot = this.#applyRetention(this.#snapshot);
    const head = this.#db.headSeq();
    this.#db.writeSnapshot(
      head,
      Date.now(),
      JSON.stringify({
        snapshot,
        v: SNAPSHOT_BLOB_VERSION,
      } satisfies PersistedBlob)
    );
    this.#snapshot = snapshot;
    this.#db.pruneEventsBefore(head);
    this.#eventsSinceSnapshot = 0;
  }

  /**
   * The only place an event becomes state.
   *
   * Boot replay and live application both land here, which is what guarantees a
   * board rebuilt from the log is byte-identical to one built incrementally.
   * Collection-level events (create/remove/select) are handled here because
   * `applyEventToBoard` deliberately ignores them.
   */
  #project(
    snapshot: WorkspaceSnapshot,
    event: WorkspaceEvent
  ): WorkspaceSnapshot {
    switch (event.type) {
      case "board.created":
        return {
          ...snapshot,
          boards: [...snapshot.boards, event.board],
          selectedBoardId: event.board.boardId,
        };

      case "board.removed": {
        const boards = snapshot.boards.filter(
          (board) => board.boardId !== event.boardId
        );
        return {
          ...snapshot,
          boards,
          selectedBoardId:
            snapshot.selectedBoardId === event.boardId
              ? (boards[0]?.boardId ?? null)
              : snapshot.selectedBoardId,
        };
      }

      case "board.selected":
        return { ...snapshot, selectedBoardId: event.boardId };

      case "board.task_plan_updated": {
        // Plan text is board-scoped but the projector's copy lives in the
        // contracts package; route through it rather than duplicating.
        const boards = snapshot.boards.map((board) =>
          board.boardId === event.boardId
            ? applyEventToBoard(board, event)
            : board
        );
        return withHistory(snapshot, boards);
      }

      case "preference.recent_model_added": {
        const withoutDuplicate = (
          snapshot.preferences.recentlyUsedModels ?? []
        ).filter(
          (model) =>
            model.providerID !== event.model.providerID ||
            model.modelID !== event.model.modelID
        );
        return {
          ...snapshot,
          preferences: {
            ...snapshot.preferences,
            recentlyUsedModels: [event.model, ...withoutDuplicate].slice(0, 5),
          },
        };
      }

      case "preference.composer_hint_dismissed":
      case "preference.speech_voice_set":
      case "preference.board_view_mode_set":
        return applyWorkspacePreference(snapshot, event);

      default: {
        if (!("boardId" in event) || event.boardId === null) {
          return snapshot;
        }

        const boards = snapshot.boards.map((board) =>
          board.boardId === event.boardId
            ? canonical(applyEventToBoard(board, event))
            : board
        );

        return boards.some((board, index) => board !== snapshot.boards[index])
          ? withHistory(snapshot, boards)
          : snapshot;
      }
    }
  }

  #applyRetention(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    return stripTerminalRunDetails(
      snapshot,
      retentionCutoff(Date.now(), this.#options.retentionDays)
    );
  }

  #parseBlob(blob: string): WorkspaceSnapshot {
    let parsed: PersistedBlob;
    try {
      parsed = JSON.parse(blob) as PersistedBlob;
    } catch (error) {
      throw new Error(
        `corrupt workspace snapshot in ${this.#db.path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (parsed.v !== SNAPSHOT_BLOB_VERSION) {
      throw new Error(
        `unsupported workspace snapshot version ${String(parsed.v)} in ${this.#db.path}`
      );
    }

    try {
      return workspaceSnapshotSchema.parse(parsed.snapshot);
    } catch (error) {
      throw new Error(
        `corrupt workspace snapshot in ${this.#db.path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  #decode(stored: StoredEvent): WorkspaceEvent {
    try {
      return JSON.parse(stored.payload) as WorkspaceEvent;
    } catch (error) {
      throw new Error(
        `corrupt event at seq ${stored.seq} in ${this.#db.path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * One-shot import of the pre-Phase-2 `workspace.json`.
   *
   * Guarded by an explicit env flag so the path can be deleted once the first
   * production migration is confirmed, and loud on corruption: a silently
   * emptied workspace is indistinguishable from data loss.
   */
  async #importLegacySnapshot(
    legacyPath: string
  ): Promise<WorkspaceSnapshot | null> {
    let raw: string;
    try {
      await access(legacyPath);
    } catch {
      return null;
    }

    raw = await readFile(legacyPath, "utf8");

    let parsed: WorkspaceSnapshot;
    try {
      parsed = workspaceSnapshotSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `refusing to start: legacy workspace snapshot at ${legacyPath} is corrupt (${
          error instanceof Error ? error.message : String(error)
        }). Move it aside to start with an empty workspace.`
      );
    }

    const importedBoards: WorkspaceBoard[] = [];
    const checkoutOwners = new Map<string, string>();
    for (const board of parsed.boards) {
      const directory = this.#repositoryRegistry
        ? await this.#repositoryRegistry.validateCandidate(board.repo.directory)
        : resolve(board.repo.directory);
      const checkout = this.#repositoryRegistry
        ? await this.#repositoryRegistry.validateAuthorizedCheckout(
            board.repo.worktree ?? directory
          )
        : resolve(board.repo.worktree ?? directory);
      const identity =
        process.platform === "win32"
          ? checkout.toLocaleLowerCase("en-US")
          : checkout;
      const previousOwner = checkoutOwners.get(identity);
      if (previousOwner) {
        throw new Error(
          `refusing to import legacy workspace at ${legacyPath}: boards ${previousOwner} and ${board.boardId} share checkout ${checkout}; preserve the source file and provision separate Chorus worktrees before retrying`
        );
      }
      checkoutOwners.set(identity, board.boardId);
      importedBoards.push({
        ...board,
        repo: {
          ...board.repo,
          directory,
          sandboxes: [],
          worktree: checkout,
        },
      });
    }

    const migrated = this.#project(
      { ...parsed, boards: importedBoards },
      {
        type: "board.selected",
        boardId: parsed.selectedBoardId,
        ts: Date.now(),
      }
    );
    return migrated;
  }

  async #parkLegacySnapshot(legacyPath: string): Promise<void> {
    const parkedPath = `${legacyPath}.imported`;
    try {
      await rename(legacyPath, parkedPath);
      return;
    } catch {
      // Windows can reject a same-volume rename when the file is held by an
      // antivirus/indexer. The database snapshot is already durable, so copy
      // into a new target first and only then remove the source.
    }

    try {
      await copyFile(legacyPath, parkedPath, fsConstants.COPYFILE_EXCL);
      await unlink(legacyPath);
    } catch (error) {
      logger.warn("workspace-legacy-snapshot-not-parked", {
        path: legacyPath,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

function withoutKeys<T extends object>(
  value: T,
  keys: readonly (keyof T)[]
): Partial<T> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}

function boardIdOf(event: WorkspaceEvent): string | null {
  return "boardId" in event ? event.boardId : null;
}

/** Keeps the "recently opened workspaces" rail populated as boards change. */
function withHistory(
  snapshot: WorkspaceSnapshot,
  boards: WorkspaceBoard[]
): WorkspaceSnapshot {
  const historyById = new Map(
    snapshot.previousWorkspaces.map((entry) => [entry.id, entry])
  );

  for (const board of boards) {
    historyById.set(createHistoryId(board), createHistoryEntry(board));
  }

  return {
    ...snapshot,
    boards,
    previousWorkspaces: sortHistory([...historyById.values()]),
  };
}

function applyWorkspacePreference(
  snapshot: WorkspaceSnapshot,
  event: WorkspaceEvent
): WorkspaceSnapshot {
  if (event.type === "preference.composer_hint_dismissed") {
    return {
      ...snapshot,
      preferences: { ...snapshot.preferences, composerHintDismissed: true },
    };
  }

  if (event.type === "preference.speech_voice_set") {
    return {
      ...snapshot,
      preferences: { ...snapshot.preferences, speechVoiceId: event.voiceId },
    };
  }

  if (event.type === "preference.board_view_mode_set") {
    return {
      ...snapshot,
      preferences: { ...snapshot.preferences, boardViewMode: event.mode },
    };
  }

  return snapshot;
}

/**
 * Derives the `session.attached` event from an attach call, so binding a
 * session goes through the shared projector instead of hand-rolling the board
 * rewrite the way the pre-Phase-2 store did.
 */
function diffSessionEvent(
  before: WorkspaceBoard,
  after: WorkspaceBoard
): WorkspaceEvent | null {
  if (after.session.sessionId === before.session.sessionId) {
    return null;
  }

  return {
    type: "session.attached",
    boardId: before.boardId,
    sessionId: after.session.sessionId ?? "",
    taskId: before.session.currentTaskId,
    ts: Date.now(),
  };
}

export { createBoardFromSeed };
