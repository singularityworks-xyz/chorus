// biome-ignore-all lint/suspicious/useAwait: every public write returns the serial queue's promise; async is the contract callers rely on

import { join } from "node:path";
import type {
  ModelSelection,
  WorkspaceBoard,
  WorkspaceEvent,
  WorkspaceMutation,
  WorkspaceSnapshot,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { z } from "zod";
import { RepositoryRegistry } from "../projects/repository-registry";
import { WORKSPACE_ID_KEY } from "./database/connection";
import type {
  MetaChange,
  PushSubscriptionRow,
  StoredPushSubscription,
} from "./database/types";
import { ChorusDatabase } from "./db";
import { attachSessionToBoard } from "./projector";
import {
  DEFAULT_RETENTION_DAYS,
  isOverSizeCap,
  MUTATION_ID_RETENTION_MS,
  type RetentionOptions,
  shouldSnapshot,
} from "./retention";
import {
  AGENT_RECEIPT_MAX_ROWS,
  AGENT_RECEIPT_RETENTION_MS,
  WorkspaceAgentEventProcessor,
} from "./store/agent-events";
import {
  WorkspaceMutationProcessor,
  worktreeCleanupKey,
} from "./store/mutations";
import {
  type PendingApprovalActionResult,
  PendingApprovalController,
} from "./store/pending-approvals";
import { WorkspacePersistence } from "./store/persistence";
import {
  boardIdOf,
  diffSessionEvent,
  EMPTY_PREFERENCES,
  projectWorkspaceEvent,
} from "./store/projection";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "STORE"
);

export interface SequencedRecord {
  boardId: string | null;
  event: WorkspaceEvent;
  seq: number;
}

export interface StoreCommit {
  boardId: string | null;
  events: WorkspaceEvent[];
  firstSeq: number;
  lastSeq: number;
}

export interface WorktreeProvisioner {
  assertRemovable?(repoDirectory: string, boardId: string): Promise<void>;
  ensureWorktree(
    repoDirectory: string,
    boardId: string,
    branch?: string
  ): Promise<string>;
  needsWorktree(
    boards: ReadonlyArray<{ repo: { directory: string } }>,
    repoDirectory: string
  ): boolean;
  removeWorktree?(repoDirectory: string, boardId: string): Promise<void>;
}

export class WorkspaceStore {
  readonly workspaceId: string;

  readonly #db: ChorusDatabase;
  readonly #options: Required<RetentionOptions>;
  readonly #queue: { promise: Promise<void> } = { promise: Promise.resolve() };
  readonly #agentEvents: WorkspaceAgentEventProcessor<StoreCommit>;
  readonly #mutations: WorkspaceMutationProcessor;
  readonly #approvals: PendingApprovalController;
  readonly #persistence: WorkspacePersistence;
  readonly #repositoryRegistry: RepositoryRegistry | undefined;
  readonly #restorePersistedRepositoryRoots: boolean;

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

  #eventsSinceSnapshot = 0;

  constructor(
    dataDir: string,
    options: RetentionOptions & {
      worktreeProvisioner?: WorktreeProvisioner;
      repositoryRegistry?: RepositoryRegistry;
      restorePersistedRepositoryRoots?: boolean;
    } = {}
  ) {
    this.#repositoryRegistry = options.repositoryRegistry;
    this.#restorePersistedRepositoryRoots =
      options.restorePersistedRepositoryRoots !== false;
    this.#db = new ChorusDatabase(dataDir);
    this.#persistence = new WorkspacePersistence(
      this.#db,
      this.#repositoryRegistry
    );
    this.#approvals = new PendingApprovalController({
      commit: (events, boardId) => {
        this.#commit(events, boardId, null);
      },
      enqueue: (work) => this.#enqueue(async () => work()),
      getBoardBySessionId: (sessionId) => this.getBoardBySessionId(sessionId),
    });
    this.#mutations = new WorkspaceMutationProcessor({
      database: this.#db,
      getSnapshot: () => this.#snapshot,
      repositoryRegistry: this.#repositoryRegistry,
      worktreeProvisioner: options.worktreeProvisioner,
    });
    this.#agentEvents = new WorkspaceAgentEventProcessor<StoreCommit>({
      commit: (events, boardId, receipts) =>
        this.#commit(events, boardId, null, [], receipts),
      enqueue: (work) => this.#enqueueNow(work, true),
      getSnapshot: () => this.#snapshot,
      hasReceipt: (id) => this.#db.hasAgentReceipt(id),
      isClosing: () => this.#closing,
      persistReceipts: (receipts) =>
        this.#db.appendEvents([], null, [], receipts),
      pruneReceipts: (cutoff, maxRows) =>
        this.#db.pruneAgentReceipts(cutoff, maxRows),
    });
    const persistedWorkspaceId = this.#db.getOrCreateMeta(
      WORKSPACE_ID_KEY,
      crypto.randomUUID()
    );
    const parsedWorkspaceId = z.uuid().safeParse(persistedWorkspaceId);
    if (parsedWorkspaceId.success) {
      this.workspaceId = parsedWorkspaceId.data;
    } else {
      this.workspaceId = crypto.randomUUID();
      this.#db.setMeta(WORKSPACE_ID_KEY, this.workspaceId);
      logger.warn("workspace-sync-identity-reset", {
        reason: "invalid-persisted-value",
      });
    }
    this.#options = {
      dbSizeCapMb: options.dbSizeCapMb ?? 512,
      retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
      snapshotInterval: options.snapshotInterval ?? 1000,
    };
  }

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

    const loaded = this.#persistence.loadLatestSnapshot();

    if (loaded) {
      this.#snapshot = loaded.snapshot;
      this.#eventsSinceSnapshot = loaded.replayed;
      logger.info("workspace-rehydrated", {
        fromSnapshotSeq: loaded.snapshotSeq,
        replayed: loaded.replayed,
        headSeq: this.#db.headSeq(),
      });
      await this.#mutations.reconcileWorktreeIntents();
      await this.#migrateLegacyGlobalModelSelection();
      return;
    }

    const imported = legacySnapshotPath
      ? await this.#persistence.importLegacySnapshot(legacySnapshotPath)
      : null;

    if (imported) {
      this.#snapshot = imported;
      logger.info("workspace-imported-legacy-snapshot", {
        boards: imported.boards.length,
      });
    }

    await this.writeSnapshot();
    if (imported && legacySnapshotPath) {
      await this.#persistence.parkLegacySnapshot(legacySnapshotPath);
    }
    await this.#mutations.reconcileWorktreeIntents();
    await this.#migrateLegacyGlobalModelSelection();
  }

  async #migrateLegacyGlobalModelSelection(): Promise<void> {
    if (this.#snapshot.preferences.defaultModelSelection) {
      return;
    }

    const selections = new Map<string, ModelSelection>();
    for (const board of this.#snapshot.boards) {
      const model = board.modelSelection;
      if (model) {
        selections.set(`${model.providerID}/${model.modelID}`, model);
      }
    }

    if (selections.size !== 1) {
      return;
    }

    const model = selections.values().next().value;
    if (!model) {
      return;
    }

    this.#db.createVerifiedBackup(
      join(this.#db.dataDir, "backups", "before-global-model-selection-v1.db")
    );

    await this.applyMutation({
      baseRevision: null,
      clientId: "chorus:global-model-migration",
      mutationId: "migration:global-model-selection:v1",
      payload: { model },
      type: "preference.default_model.set",
    });
  }

  async drain(): Promise<void> {
    this.#agentEvents.flushPendingDeltas();
    await this.#agentEvents.waitForIdle();
    await this.#enqueue(async () => undefined);
  }

  async close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closing = true;
    this.#agentEvents.flushPendingDeltas();
    const closePromise = this.#agentEvents
      .waitForIdle()
      .then(() => this.#queue.promise)
      .then(() => {
        this.#writeSnapshotNow();
        this.#db.checkpointTruncate();
        this.#db.close();
      });
    this.#closePromise = closePromise;
    return closePromise;
  }

  getSnapshot(): WorkspaceSnapshot {
    return structuredClone(this.#snapshot);
  }

  getBoard(boardId: string): WorkspaceBoard | undefined {
    return this.#snapshot.boards.find((board) => board.boardId === boardId);
  }

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

  replayFloorSeq(): number {
    return this.#db.latestSnapshot()?.seq ?? 0;
  }

  eventsSince(seq: number, limit?: number): SequencedRecord[] {
    const rows = this.#db.readEventsSince(
      seq,
      limit ?? Number.MAX_SAFE_INTEGER
    );

    return rows.map((row) => ({
      boardId: row.boardId,
      event: this.#persistence.decodeEvent(row),
      seq: row.seq,
    }));
  }

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
    requestId: string,
    resume = false
  ): Promise<boolean> {
    return this.#approvals.resolve(sessionId, requestId, resume);
  }

  async runPendingApprovalAction<T>(
    sessionId: string,
    requestId: string,
    action: () => Promise<T>,
    options: {
      accepts?: (value: T) => boolean;
      resume?: boolean;
    } = {}
  ): Promise<PendingApprovalActionResult<T>> {
    return this.#approvals.run(sessionId, requestId, action, options);
  }

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
    const produced = await this.#mutations.produce(mutation, now);
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
        key: worktreeCleanupKey(produced.cleanup.boardId),
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
      await this.#mutations.compensateProvisionedBoard(produced.events);
      throw error;
    }

    if (produced.cleanup) {
      await this.#mutations.finishCommittedCleanup(produced.cleanup);
    }
    return commit;
  }

  applyAgentEvent(
    agentEvent: NormalizedAgentEvent
  ): Promise<StoreCommit | null> {
    return this.#agentEvents.apply(agentEvent);
  }

  async applyBoardEvents(
    boardId: string,
    events: WorkspaceEvent[]
  ): Promise<StoreCommit | null> {
    return this.applyBoardEventsIf(boardId, events, () => true);
  }

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

  async writeSnapshot(): Promise<void> {
    await this.#enqueue(async () => {
      this.#writeSnapshotNow();
    });
  }

  async runRetention(): Promise<void> {
    await this.writeSnapshot();
    logger.info("workspace-retention-ran", {
      eventsRemaining: this.#db.eventCount(),
      headSeq: this.#db.headSeq(),
    });
  }

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

  onCommit(listener: (commit: StoreCommit) => void): () => void {
    this.#commitListeners.add(listener);
    return () => {
      this.#commitListeners.delete(listener);
    };
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new Error("workspace store is closing or closed"));
    }

    this.#agentEvents.flushPendingDeltas();
    return this.#agentEvents.waitForIdle().then(() =>
      // An operation accepted before close must remain queued through shutdown.
      this.#enqueueNow(work, true)
    );
  }

  #enqueueNow<T>(work: () => Promise<T>, allowClosing = false): Promise<T> {
    if (this.#closing && !allowClosing) {
      return Promise.reject(new Error("workspace store is closing or closed"));
    }

    const result = this.#queue.promise.then(work);
    this.#queue.promise = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #commit(
    events: WorkspaceEvent[],
    boardId: string | null,
    mutationKey: { id: string; ts: number } | null,
    metaChanges: MetaChange[] = [],
    agentReceipt?:
      | { id: string; ts: number }
      | Array<{ id: string; ts: number }>
  ): StoreCommit {
    // Persist first so a failed append leaves the in-memory snapshot unchanged.
    let candidate = this.#snapshot;
    for (const event of events) {
      candidate = projectWorkspaceEvent(candidate, event);
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

    // Subscribers run after persistence and cannot invalidate a committed write.
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
        logger.error(
          "workspace-snapshot-failed",
          error instanceof Error ? error : undefined
        );
      }
    }

    return commit;
  }

  #writeSnapshotNow(): void {
    const saved = this.#persistence.writeSnapshot(
      this.#snapshot,
      this.#options.retentionDays
    );
    this.#snapshot = saved.snapshot;
    this.#persistence.pruneEventsBefore(saved.head);
    this.#eventsSinceSnapshot = 0;
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
