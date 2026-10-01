// biome-ignore-all lint/suspicious/useAwait: handleRawMessage is async without an await — it is the public inbound contract callers await, kept async so a future store-backed read needs no signature change.
import {
  boardIdOfEvent,
  clientHelloSchema,
  clientPongSchema,
  MAX_REPLAY_GAP,
  resyncRequestSchema,
  sequencedEventSchema,
  serverErrorSchema,
  serverReadySchema,
  snapshotMessageSchema,
  viewportSyncSchema,
  type WorkspaceEvent,
  WS_CLOSE_RATE_LIMITED,
} from "@chorus/contracts";
import type {
  SequencedRecord,
  StoreCommit,
  WorkspaceStore,
} from "../workspace/store";

/**
 * WebSocket hub for the native `/ws` event log (spec §4).
 *
 * Single owner of every downstream byte. Routes and the bridge do not touch
 * sockets — they hand the hub a `StoreCommit` and the hub decides what goes
 * out. That is the whole point: one emit path from the store's commit point.
 *
 * ## Backpressure — measured, not assumed
 *
 * The Day-1 spike (`.context/ws-backpressure-spike.md`, harness in
 * `apps/serve/scripts/ws-backpressure-spike.ts`) established three things that
 * shape this file:
 *
 * 1. `send()` returns the bytes accepted in all 4000 sends, including against a
 *    16.0 MiB backlog. It never returns 0 or -1, so its return value is **not**
 *    a congestion signal. The only usable one is `getBufferedAmount()`.
 * 2. There is no implicit cap: the buffer reached 16,782,710 bytes with a
 *    stalled reader and nothing complained.
 * 3. `drain` fires, but the first fire came with 15,059,396 bytes already
 *    queued — a late notification, not an early warning. So `drain` is never
 *    used to set the critical-only flag; it only triggers a re-check.
 *
 * Recovery does terminate (the buffer fell to 0 once the reader resumed), so a
 * client flagged critical-only does clear and the flag cannot latch forever.
 *
 * See `publish()` for how these map onto the two delivery classes.
 */

/** ~30x a typical step-delta patch, 60x below where `drain` first surfaced. */
export const HIGH_WATER_MARK = 262_144;

/** Coalescing bucket for workspace-scoped (non-board) events. */
const WORKSPACE_SCOPE_KEY = "__workspace__";

/** Commands per client per minute before the socket is dropped. */
export const WS_COMMAND_LIMIT_PER_MINUTE = 60;

export const PING_INTERVAL_MS = 30_000;
export const PONG_TIMEOUT_MS = 10_000;
export const COALESCE_MS = 100;

/**
 * Transport-agnostic view of a socket, so the hub is unit-testable without an
 * HTTP server and Bun-specific wiring stays at the edge.
 */
export interface HubSocket {
  close?: (code?: number, reason?: string) => void;
  getBufferedAmount?: () => number;
  send: (data: string) => unknown;
}

/** Identity under which two buffered records describe the same work. */
function mergeKeyFor(record: SequencedRecord): string {
  const event = record.event;
  if (event.type === "step.delta_appended") {
    return `${record.boardId ?? ""}|delta|${event.taskId}|${event.stepId}`;
  }
  if (event.type === "step.upserted") {
    return `${record.boardId ?? ""}|upsert|${event.taskId}|${event.step.id}`;
  }
  return `${record.boardId ?? ""}|${record.seq}`;
}

/**
 * Folds `next` into `target` in place when they are mergeable, reporting
 * whether the merge happened. Returns false when the pair is not the same unit
 * of work, in which case the caller buffers `next` separately.
 */
function mergeRecords(target: SequencedRecord, next: SequencedRecord): boolean {
  const a = target.event;
  const b = next.event;

  if (a.type === "step.delta_appended" && b.type === "step.delta_appended") {
    if (a.taskId !== b.taskId || a.stepId !== b.stepId) {
      return false;
    }
    a.delta = `${a.delta}${b.delta}`;
    return true;
  }

  if (a.type === "step.upserted" && b.type === "step.upserted") {
    if (a.taskId !== b.taskId || a.step.id !== b.step.id) {
      return false;
    }
    // Latest content wins: the later upsert is the more current view of the step.
    a.step = b.step;
    return true;
  }

  // A delta after an upsert for the same step still belongs to that step's
  // transcript, but the two message shapes differ, so it flushes separately
  // rather than being silently reshaped.
  return false;
}

/**
 * How to satisfy a resuming client.
 *
 * `pruned` exists because of a gap that is easy to miss: once events are pruned
 * into a snapshot, a client resuming from before that floor can have a *small*
 * gap — inside `MAX_REPLAY_GAP` — and still be missing everything, because the
 * rows no longer exist. Replaying what is left would silently diverge. Deciding
 * this in one pure, tested function is what keeps that from being re-derived
 * (incorrectly) at each call site.
 */
export type ResumeDecision =
  | { kind: "replay"; fromSeq: number }
  | {
      kind: "snapshot";
      reason: "client-ahead" | "gap-too-large" | "initial" | "pruned";
    }
  | { kind: "up-to-date" };

export function decideResume(
  since: number,
  head: number,
  replayFloor: number
): ResumeDecision {
  if (since > head) {
    // The client is ahead of the server: a restored database, or a different
    // one entirely. Replaying nothing would leave it permanently ahead.
    return { kind: "snapshot", reason: "client-ahead" };
  }

  if (since === head) {
    return { kind: "up-to-date" };
  }

  if (since < replayFloor) {
    return { kind: "snapshot", reason: "pruned" };
  }

  if (head - since > MAX_REPLAY_GAP) {
    return { kind: "snapshot", reason: "gap-too-large" };
  }

  return { kind: "replay", fromSeq: since };
}

interface Client {
  /** Board filter; `null` means every board (the single-operator mirror). */
  boards: Set<string> | null;
  commandsThisMinute: number;
  commandWindowStart: number;
  criticalOnly: boolean;
  id: string;
  lastPongAt: number;
  /** Sequences already in this client's buffer. Gaps must be impossible. */
  lastSeq: number;
  /** True once `hello` completed — nothing is pushed before that. */
  ready: boolean;
  socket: HubSocket;
}

export interface HubOptions {
  coalesceMs?: number;
  now?: () => number;
  pingIntervalMs?: number;
}

export interface HubStats {
  clients: number;
  coalescerDepth: number;
  headSeq: number;
}

let clientCounter = 0;

export class WorkspaceHub {
  readonly #clients = new Set<Client>();
  readonly #store: WorkspaceStore;
  readonly #now: () => number;
  readonly #coalesceMs: number;
  readonly #pingIntervalMs: number;

  /**
   * Per-board buffers of coalescible events awaiting flush. Holds whole
   * `SequencedRecord`s, not bare events: a coalesced delta must keep its
   * sequence, or the client loses track of its own position in the log.
   */
  readonly #pending = new Map<string, SequencedRecord[]>();

  /**
   * Where a record will merge into one already buffered, keyed by the identity
   * that makes two events the *same* piece of work: a run streaming tokens
   * arrives as hundreds of deltas for one `stepId`, and sending one frame per
   * token is exactly what the coalescing window exists to prevent.
   */
  readonly #mergeIndex = new Map<string, SequencedRecord>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: WorkspaceStore, options: HubOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.#pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.#startHeartbeat();
  }

  // ── registry ──────────────────────────────────────────────────────────────

  register(socket: HubSocket): Client {
    clientCounter += 1;
    const client: Client = {
      boards: null,
      commandsThisMinute: 0,
      commandWindowStart: this.#now(),
      criticalOnly: false,
      id: `c${clientCounter}`,
      lastPongAt: this.#now(),
      lastSeq: 0,
      ready: false,
      socket,
    };

    this.#clients.add(client);
    return client;
  }

  unregister(socket: HubSocket): void {
    for (const client of this.#clients) {
      if (client.socket === socket) {
        this.#clients.delete(client);
      }
    }
  }

  clientCount(): number {
    return this.#clients.size;
  }

  stats(): HubStats {
    return {
      clients: this.#clients.size,
      coalescerDepth: [...this.#pending.values()].reduce(
        (sum, buffer) => sum + buffer.length,
        0
      ),
      headSeq: this.#store.headSeq(),
    };
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  /**
   * Handles one raw client frame. Malformed input is answered with an error
   * message and never throws into the socket's message handler.
   */
  async handleRawMessage(
    socket: HubSocket,
    raw: string | Uint8Array
  ): Promise<void> {
    const client = this.#find(socket);
    if (!client) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw)
      );
    } catch {
      this.#sendError(socket, "malformed json");
      return;
    }

    const message = parsed as { type?: unknown };

    if (typeof message.type !== "string") {
      this.#sendError(socket, "missing message type");
      return;
    }

    if (!this.#consumeCommandBudget(client)) {
      // Spec §6: cap per-client command rate. Dropping the socket is the point;
      // a silent throttle would just let a flood continue.
      client.socket.close?.(WS_CLOSE_RATE_LIMITED, "command rate exceeded");
      this.unregister(socket);
      return;
    }

    switch (message.type) {
      case "hello": {
        const hello = clientHelloSchema.safeParse(parsed);
        if (!hello.success) {
          this.#sendError(socket, "invalid hello");
          return;
        }
        this.#handleHello(client, hello.data.since);
        return;
      }

      case "resync": {
        if (!resyncRequestSchema.safeParse(parsed).success) {
          this.#sendError(socket, "invalid resync");
          return;
        }
        this.#sendSnapshot(client);
        return;
      }

      case "pong": {
        if (clientPongSchema.safeParse(parsed).success) {
          client.lastPongAt = this.#now();
        }
        return;
      }

      case "viewport.sync": {
        const viewport = viewportSyncSchema.safeParse(parsed);
        if (!viewport.success) {
          this.#sendError(socket, "invalid viewport.sync");
          return;
        }
        this.#relayViewport(client, viewport.data.payload);
        return;
      }

      default:
        // Command types (task.queue, task.approve, ...) are handled by the
        // legacy command handler; the hub only relays state.
        return;
    }
  }

  /**
   * Resume handshake (spec §4).
   *
   * Sends `ready` with the current head, then either the exact gap, nothing at
   * all, or a fresh snapshot — decided by `decideResume`.
   */
  #handleHello(client: Client, since: number): void {
    const head = this.#store.headSeq();
    this.#send(client, serverReadySchema.parse({ head, type: "ready" }));

    // A reconnect is a brand-new socket with no memory of the previous one, so
    // the decision has to come from `since` alone — nothing per-connection can
    // be trusted here. `since === 0` means the client has no history at all, and
    // preferences/view mode live only in the snapshot blob, so it gets one.
    const decision =
      since === 0
        ? ({ kind: "snapshot", reason: "initial" } as const)
        : decideResume(since, head, this.#store.replayFloorSeq());

    switch (decision.kind) {
      case "up-to-date":
        // Nothing is missing, so there is nothing to send. A snapshot here
        // would be pure waste on every reconnect.
        break;

      case "replay": {
        for (const record of this.#store.eventsSince(decision.fromSeq)) {
          this.#sendSequenced(client, record);
        }
        client.lastSeq = head;
        break;
      }

      case "snapshot":
        this.#sendSnapshot(client);
        break;

      default:
        // Unreachable while ResumeDecision and this switch agree; the store
        // snapshot is the safe fallback if they ever drift.
        this.#sendSnapshot(client);
        break;
    }

    client.ready = true;
  }

  #sendSnapshot(client: Client): void {
    const snapshot = this.#store.getSnapshot();
    this.#send(
      client,
      snapshotMessageSchema.parse({
        data: {
          boards: snapshot.boards,
          preferences: snapshot.preferences,
          selectedBoardId: snapshot.selectedBoardId,
          v: 1,
        },
        seq: this.#store.headSeq(),
        type: "snapshot",
      })
    );
    client.lastSeq = this.#store.headSeq();
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  /**
   * Fans out a store commit.
   *
   * Events are appended contiguously, so each one's sequence is derivable from
   * the commit's range — no second bookkeeping to keep in sync.
   */
  publish(commit: StoreCommit): void {
    commit.events.forEach((event, index) => {
      this.publishRecord({
        boardId: boardIdOfEvent(event) ?? commit.boardId,
        event,
        seq: commit.firstSeq + index,
      });
    });
  }

  /**
   * Fans out one already-sequenced record.
   *
   * Public because callers that hold a single log entry (a replay, a test
   * harness, a future admin tool) should not have to synthesise a fake commit
   * to reach the delivery path.
   */
  publishRecord(record: SequencedRecord): void {
    if (this.#isCoalescible(record.event)) {
      this.#buffer(record);
      return;
    }

    this.#deliver(record);
  }

  /**
   * Adds a record to its board's buffer, merging it into an existing entry when
   * both describe the same unit of work.
   *
   * Time-batching alone is not enough. 500 deltas published inside one
   * `COALESCE_MS` window would still be 500 frames in a single flush — the
   * window would bound *when* they arrive, not *how many*. Merging by step is
   * what actually reduces the frame count, and it is lossless: appended deltas
   * concatenate, and an upsert for a step already buffered keeps the latest.
   *
   * Sequence numbers cannot merge, so a merged record keeps the **earliest**
   * seq of the run it represents. The client then sees a sequence it has already
   * advanced past, which is harmless — sequences are for gap detection, and no
   * gap is created.
   */
  #buffer(record: SequencedRecord): void {
    const key = record.boardId ?? WORKSPACE_SCOPE_KEY;
    const mergeKey = mergeKeyFor(record);
    const existing = this.#mergeIndex.get(mergeKey);

    if (existing && mergeRecords(existing, record)) {
      return;
    }

    const buffer = this.#pending.get(key) ?? [];
    buffer.push(record);
    this.#pending.set(key, buffer);
    this.#mergeIndex.set(mergeKey, record);
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) {
      return;
    }
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, this.#coalesceMs);
    // Never hold the process open for a coalescing window.
    this.#flushTimer.unref?.();
  }

  /** Flushes every buffered board. Exposed so tests need not wait on timers. */
  flush(): void {
    if (this.#pending.size === 0) {
      return;
    }

    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    this.#mergeIndex.clear();

    for (const [, records] of entries) {
      for (const record of records) {
        this.#deliver(record);
      }
    }
  }

  #deliver(record: SequencedRecord): void {
    for (const client of this.#clients) {
      if (!client.ready) {
        continue;
      }
      this.#deliverTo(client, record);
    }
  }

  /**
   * Per-client delivery with the measured backpressure policy.
   *
   * Above the mark the client is switched to critical-only: control events keep
   * flowing, coalescible patches are skipped, and the client catches up via
   * `hello(since)` when it reconnects. Nothing is silently lost.
   */
  #deliverTo(client: Client, record: SequencedRecord): void {
    if (client.boards && record.boardId && !client.boards.has(record.boardId)) {
      return;
    }

    // Re-check the buffer *before* deciding to drop. Doing it the other way
    // round latches the flag permanently: a critical-only client short-circuits
    // every coalescible event, so the recovery branch below never runs and the
    // client is throttled until it disconnects. The spike confirmed the buffer
    // does drain, so the flag has to be able to observe that.
    const buffered = client.socket.getBufferedAmount?.() ?? 0;
    if (buffered > HIGH_WATER_MARK) {
      client.criticalOnly = true;
    } else if (client.criticalOnly && buffered < HIGH_WATER_MARK / 2) {
      // Hysteresis: only clear once comfortably below, so a client hovering at
      // the mark does not flip state on every message.
      client.criticalOnly = false;
    }

    if (client.criticalOnly && this.#isCoalescible(record.event)) {
      return;
    }

    this.#sendSequenced(client, record);
  }

  #sendSequenced(client: Client, record: SequencedRecord): void {
    this.#send(
      client,
      sequencedEventSchema.parse({
        boardId: record.boardId,
        event: record.event,
        seq: record.seq,
        ts: record.event.ts,
        type: "event",
      })
    );
    client.lastSeq = Math.max(client.lastSeq, record.seq);
  }

  /**
   * The one sanctioned passthrough (spec §4): viewport relay is ephemeral,
   * unsequenced, unpersisted, and never touches the event log.
   */
  #relayViewport(origin: Client, payload: Record<string, unknown>): void {
    const message = JSON.stringify({
      payload,
      timestamp: this.#now(),
      type: "viewport.sync",
    });

    for (const client of this.#clients) {
      if (client === origin || !client.ready) {
        continue;
      }
      client.socket.send(message);
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      const cutoff = this.#now() - PONG_TIMEOUT_MS * 2;
      for (const client of [...this.#clients]) {
        if (client.lastPongAt < cutoff) {
          client.socket.close?.(4000, "pong timeout");
          this.#clients.delete(client);
          continue;
        }
        client.socket.send(JSON.stringify({ at: this.#now(), type: "ping" }));
      }
    }, this.#pingIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  close(): void {
    this.#mergeIndex.clear();
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#pending.clear();

    for (const client of [...this.#clients]) {
      client.socket.close?.(1001, "server shutting down");
    }
    this.#clients.clear();
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  #find(socket: HubSocket): Client | undefined {
    for (const client of this.#clients) {
      if (client.socket === socket) {
        return client;
      }
    }
    return undefined;
  }

  #isCoalescible(event: WorkspaceEvent): boolean {
    return (
      event.type === "step.upserted" || event.type === "step.delta_appended"
    );
  }

  #consumeCommandBudget(client: Client): boolean {
    const now = this.#now();
    if (now - client.commandWindowStart >= 60_000) {
      client.commandWindowStart = now;
      client.commandsThisMinute = 0;
    }
    client.commandsThisMinute += 1;
    return client.commandsThisMinute <= WS_COMMAND_LIMIT_PER_MINUTE;
  }

  #send(client: Client, message: unknown): void {
    client.socket.send(JSON.stringify(message));
  }

  #sendError(socket: HubSocket, message: string): void {
    socket.send(
      JSON.stringify(serverErrorSchema.parse({ message, type: "error" }))
    );
  }
}
