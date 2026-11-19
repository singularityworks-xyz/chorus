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

/** A decoded event log entry. */
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

export type PendingApprovalActionResult<T> =
  | { status: "accepted"; value: T }
  | { status: "already_resolving" }
  | { status: "not_pending" }
  | { status: "rejected" };

export function pendingApprovalConflictMessage(
  status: "already_resolving" | "not_pending"
): string {
  return status === "already_resolving"
    ? "Another client is already responding to this request. Wait for the board to sync before trying again."
    : "This request is no longer waiting for a response. Refresh the board to see the current task state.";
}

/** Provisions board worktrees without coupling the store to git commands. */
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

/** Owns workspace state, durable event writes, replay, and commit ordering. */
export class WorkspaceStore {
  readonly workspaceId: string;

  readonly #db: ChorusDatabase;
  readonly #options: Required<RetentionOptions>;
  readonly #queue: { promise: Promise<void> } = { promise: Promise.resolve() };
  readonly #agentEvents: WorkspaceAgentEventProcessor<StoreCommit>;
  readonly #mutations: WorkspaceMutationProcessor;
  readonly #persistence: WorkspacePersistence;
  readonly #repositoryRegistry: RepositoryRegistry | undefined;
  readonly #restorePersistedRepositoryRoots: boolean;

  readonly #commitListeners = new Set<(commit: StoreCommit) => void>();
  readonly #pendingApprovalActions = new Set<string>();
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

  /**
   * Promote one unambiguous historical board model to the application default.
   * Conflicting legacy selections stay unset so Settings can ask for one choice;
   * no board is allowed to keep controlling future runs independently.
   */
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

  /** Resolves when every queued state change has committed. */
  async drain(): Promise<void> {
    this.#agentEvents.flushPendingDeltas();
    await this.#agentEvents.waitForIdle();
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
      event: this.#persistence.decodeEvent(row),
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
    requestId: string,
    resume = false
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
      const ts = Date.now();
      const events: WorkspaceEvent[] = [
        {
          boardId: board.boardId,
          requestId,
          taskId: task.id,
          ts,
          type: "card.approval_resolved",
        },
      ];
      const pendingApprovals =
        task.pendingApprovals ??
        (task.pendingApproval ? [task.pendingApproval] : []);
      const hasOtherPendingApprovals = pendingApprovals.some(
        (request) => request.requestId !== requestId
      );
      if (resume && !hasOtherPendingApprovals) {
        events.push({
          boardId: board.boardId,
          taskId: task.id,
          ts,
          type: "card.started",
        });
      }
      this.#commit(events, board.boardId, null);
      return true;
    });
  }

  /**
   * Runs one provider response for a pending approval/question request.
   *
   * The reservation is made inside the workspace write queue so requests from
   * separate HTTP and WebSocket clients cannot both pass a stale-state check.
   * Provider I/O happens outside the queue; other board events keep flowing
   * while the engine processes the answer. Failed or declined provider calls
   * release the reservation and leave the request available for a retry.
   */
  async runPendingApprovalAction<T>(
    sessionId: string,
    requestId: string,
    action: () => Promise<T>,
    options: {
      accepts?: (value: T) => boolean;
      resume?: boolean;
    } = {}
  ): Promise<PendingApprovalActionResult<T>> {
    const actionKey = JSON.stringify([sessionId, requestId]);
    const claim = await this.#enqueue(async () => {
      if (this.#pendingApprovalActions.has(actionKey)) {
        return "already_resolving" as const;
      }

      const board = this.#snapshot.boards.find(
        (entry) => entry.session.sessionId === sessionId
      );
      const isPending = board
        ? Object.values(board.columns)
            .flat()
            .some((task) =>
              (
                task.pendingApprovals ??
                (task.pendingApproval ? [task.pendingApproval] : [])
              ).some((request) => request.requestId === requestId)
            )
        : false;
      if (!isPending) {
        return "not_pending" as const;
      }

      this.#pendingApprovalActions.add(actionKey);
      return "claimed" as const;
    });

    if (claim !== "claimed") {
      return { status: claim };
    }

    try {
      const value = await action();
      if (options.accepts && !options.accepts(value)) {
        return { status: "rejected" };
      }

      await this.resolvePendingApproval(
        sessionId,
        requestId,
        options.resume ?? false
      );
      return { status: "accepted", value };
    } finally {
      this.#pendingApprovalActions.delete(actionKey);
    }
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

  /** Applies one normalized provider event to the shared workspace log. */
  applyAgentEvent(
    agentEvent: NormalizedAgentEvent
  ): Promise<StoreCommit | null> {
    return this.#agentEvents.apply(agentEvent);
  }

  /**
   * Commits `card.created` before later agent events need the task binding.
   * Events still use the regular commit path and hub notification.
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

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new Error("workspace store is closing or closed"));
    }

    this.#agentEvents.flushPendingDeltas();
    return this.#agentEvents.waitForIdle().then(() =>
      // Once accepted above, preserve this operation through close. close()
      // waits for the event tail and then the queue; rejecting here would drop
      // a pre-close write that was waiting behind a buffered stream batch.
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
    agentReceipt?:
      | { id: string; ts: number }
      | Array<{ id: string; ts: number }>
  ): StoreCommit {
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
