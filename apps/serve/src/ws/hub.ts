import {
  boardIdOfEvent,
  clientHelloSchema,
  clientPongSchema,
  resyncRequestSchema,
  sequencedEventSchema,
  serverErrorSchema,
  serverReadySchema,
  snapshotMessageSchema,
  viewportSyncSchema,
  WS_CLOSE_RATE_LIMITED,
  WS_CLOSE_UNAUTHORIZED,
} from "@chorus/contracts";
import type { WorkspaceStore } from "../workspace/store";
import type { SequencedRecord, StoreCommit } from "../workspace/store/types";
import { bufferOf } from "./hub/coalescing";
import { HubEventDelivery } from "./hub/delivery";
import {
  HIGH_WATER_MARK as deliveryHighWaterMark,
  MAX_COALESCE_BUFFER as deliveryMaxCoalesceBuffer,
  RECOVERY_SENDS as deliveryRecoverySends,
} from "./hub/limits";
import { decideResume } from "./hub/resume";
import type {
  BufferedRecord,
  HubClient,
  HubOptions,
  HubSocket,
  HubStats,
} from "./hub/types";

export const HIGH_WATER_MARK = deliveryHighWaterMark;
export const MAX_COALESCE_BUFFER = deliveryMaxCoalesceBuffer;
export const RECOVERY_SENDS = deliveryRecoverySends;

export const WS_CONTROL_LIMIT_PER_MINUTE = 60;

export const MAX_CONSECUTIVE_DROPS = 5;

export const MAX_TELEMETRY_PER_MINUTE = 600;

const BUDGET_EXEMPT_TYPES = new Set(["pong", "viewport.sync"]);

export const PING_INTERVAL_MS = 30_000;
export const PONG_TIMEOUT_MS = 10_000;
export const COALESCE_MS = 100;

export class WorkspaceHub {
  readonly #clients = new Map<string, HubClient>();
  readonly #dropReasons = new Map<string, number>();
  readonly #store: WorkspaceStore;
  readonly #now: () => number;
  readonly #pingIntervalMs: number;
  readonly #pongTimeoutMs: number;
  readonly #isDeviceAllowed: HubOptions["isDeviceAllowed"];

  readonly #delivery: HubEventDelivery;
  #closed = false;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: WorkspaceStore, options: HubOptions = {}) {
    this.#isDeviceAllowed = options.isDeviceAllowed;
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.#pongTimeoutMs = options.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.#delivery = new HubEventDelivery({
      coalesceMs: options.coalesceMs ?? COALESCE_MS,
      clients: () => this.#clients.values(),
      sendSequenced: (client, record) => this.#sendSequenced(client, record),
    });
    this.#startHeartbeat();
  }

  get workspaceId(): string {
    return this.#store.workspaceId;
  }

  register(socket: HubSocket, deviceId?: string): HubClient {
    const existing = this.#clients.get(socket.id);
    if (existing) {
      this.#drop(existing, "connection-replaced");
    }

    const client: HubClient = {
      backpressuredFrames: 0,
      cleanSends: 0,
      controlMessagesThisMinute: 0,
      consecutiveDrops: 0,
      droppedFrames: 0,
      ...(deviceId ? { deviceId } : {}),
      controlWindowStart: this.#now(),
      telemetryThisMinute: 0,
      telemetryWindowStart: this.#now(),
      criticalOnly: false,
      id: socket.id,
      lastPongAt: this.#now(),
      lastSeq: 0,
      ready: false,
      socket,
    };

    this.#clients.set(socket.id, client);
    return client;
  }

  unregister(socket: HubSocket): void {
    const client = this.#clients.get(socket.id);
    if (client) {
      this.#drop(client, "socket-closed");
    }
  }

  disconnectDevice(deviceId: string): number {
    const clients = [...this.#clients.values()].filter(
      (client) => client.deviceId === deviceId
    );
    for (const client of clients) {
      client.socket.close?.(1000, "signed out");
      this.#drop(client, "signed-out");
    }
    return clients.length;
  }

  clientCount(): number {
    return this.#clients.size;
  }

  hasReadyConnectionForDevice(deviceId: string): boolean {
    const healthyWithinMs = this.#pingIntervalMs + this.#pongTimeoutMs;
    const now = this.#now();
    return [...this.#clients.values()].some(
      (client) =>
        client.deviceId === deviceId &&
        client.ready &&
        now - client.lastPongAt <= healthyWithinMs
    );
  }

  stats(): HubStats {
    let backpressuredFrames = 0;
    let criticalOnlyClients = 0;
    let droppedFrames = 0;

    for (const client of this.#clients.values()) {
      backpressuredFrames += client.backpressuredFrames;
      droppedFrames += client.droppedFrames;
      if (client.criticalOnly) {
        criticalOnlyClients += 1;
      }
    }

    return {
      backpressuredFrames,
      clients: this.#clients.size,
      coalescerDepth: this.#delivery.pendingCount,
      criticalOnlyClients,
      droppedFrames,
      dropReasons: Object.fromEntries(this.#dropReasons),
      headSeq: this.#store.headSeq(),
    };
  }

  // biome-ignore lint/suspicious/useAwait: Preserve the async socket-handler contract.
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

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("type" in parsed) ||
      typeof parsed.type !== "string"
    ) {
      this.#sendError(socket, "missing message type");
      return;
    }
    if (
      !(
        BUDGET_EXEMPT_TYPES.has(parsed.type) ||
        this.#consumeControlBudget(client)
      )
    ) {
      client.socket.close?.(WS_CLOSE_RATE_LIMITED, "control rate exceeded");
      this.#drop(client, "control-rate-limit");
      return;
    }

    this.#dispatch(client, socket, parsed, parsed.type);
  }

  #dispatch(
    client: HubClient,
    socket: HubSocket,
    parsed: unknown,
    type: string
  ): void {
    switch (type) {
      case "hello": {
        const hello = clientHelloSchema.safeParse(parsed);
        if (!hello.success) {
          this.#sendError(socket, "invalid hello");
          return;
        }
        if (client.ready) {
          this.#sendError(socket, "already initialised");
          return;
        }
        this.#handleHello(client, hello.data.since, hello.data.workspaceId);
        return;
      }

      case "resync": {
        if (!resyncRequestSchema.safeParse(parsed).success) {
          this.#sendError(socket, "invalid resync");
          return;
        }
        if (!client.ready) {
          this.#sendError(socket, "resync before hello");
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
        if (!this.#consumeTelemetryBudget(client)) {
          return;
        }
        this.#relayViewport(client, viewport.data.payload);
        return;
      }

      default:
        this.#sendError(socket, `unsupported message type: ${type}`);
        return;
    }
  }

  #handleHello(
    client: HubClient,
    since: number,
    clientWorkspaceId?: string
  ): void {
    const head = this.#store.headSeq();
    this.#send(
      client,
      serverReadySchema.parse({
        head,
        type: "ready",
        workspaceId: this.#store.workspaceId,
      })
    );
    const decision =
      since === 0
        ? ({ kind: "snapshot", reason: "initial" } as const)
        : decideResume(
            since,
            head,
            this.#store.replayFloorSeq(),
            clientWorkspaceId === this.#store.workspaceId
          );

    switch (decision.kind) {
      case "up-to-date":
        break;

      case "replay": {
        for (const record of this.#store.eventsSince(decision.fromSeq)) {
          this.#sendSequenced(client, bufferOf(record));
        }
        client.lastSeq = head;
        break;
      }

      case "snapshot":
        this.#sendSnapshot(client);
        break;

      default:
        this.#sendSnapshot(client);
        break;
    }

    client.ready = true;
  }

  #sendSnapshot(client: HubClient): void {
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

  publish(commit: StoreCommit): void {
    if (this.#closed) {
      return;
    }

    commit.events.forEach((event, index) => {
      this.publishRecord({
        boardId: boardIdOfEvent(event),
        event,
        seq: commit.firstSeq + index,
      });
    });
  }

  publishRecord(record: SequencedRecord): void {
    if (this.#closed) {
      return;
    }

    this.#delivery.publishRecord(record);
  }

  flush(): void {
    this.#delivery.flush();
  }

  #sendSequenced(client: HubClient, record: BufferedRecord): void {
    this.#send(
      client,
      sequencedEventSchema.parse({
        boardId: record.boardId,
        event: record.event,
        fromSeq: record.fromSeq,
        seq: record.toSeq,
        ts: record.event.ts,
        type: "event",
      })
    );
    // Advance only across a contiguous range; skipped frames must be replayed.
    if (record.fromSeq === client.lastSeq + 1) {
      client.lastSeq = record.toSeq;
    }
  }

  #relayViewport(origin: HubClient, payload: Record<string, unknown>): void {
    const message = {
      payload,
      timestamp: this.#now(),
      type: "viewport.sync",
    };

    for (const client of this.#clients.values()) {
      if (client === origin || !client.ready) {
        continue;
      }
      this.#send(client, message);
    }
  }

  #drop(client: HubClient, reason: string): void {
    if (this.#clients.get(client.id) !== client) {
      return;
    }
    this.#clients.delete(client.id);
    this.#dropReasons.set(reason, (this.#dropReasons.get(reason) ?? 0) + 1);
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      const cutoff = this.#now() - this.#pingIntervalMs - this.#pongTimeoutMs;
      for (const client of [...this.#clients.values()]) {
        if (client.lastPongAt < cutoff) {
          client.socket.close?.(4000, "pong timeout");
          this.#drop(client, "pong-timeout");
          continue;
        }
        this.#send(client, { at: this.#now(), type: "ping" });
      }
    }, this.#pingIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  close(): void {
    this.#closed = true;

    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#delivery.close();

    for (const client of [...this.#clients.values()]) {
      client.socket.close?.(1001, "server shutting down");
      this.#drop(client, "server-shutdown");
    }
  }

  #find(socket: HubSocket): HubClient | undefined {
    return this.#clients.get(socket.id);
  }

  #consumeTelemetryBudget(client: HubClient): boolean {
    const now = this.#now();
    if (now - client.telemetryWindowStart >= 60_000) {
      client.telemetryWindowStart = now;
      client.telemetryThisMinute = 0;
    }
    client.telemetryThisMinute += 1;
    return client.telemetryThisMinute <= MAX_TELEMETRY_PER_MINUTE;
  }

  #consumeControlBudget(client: HubClient): boolean {
    const now = this.#now();
    if (now - client.controlWindowStart >= 60_000) {
      client.controlWindowStart = now;
      client.controlMessagesThisMinute = 0;
    }
    client.controlMessagesThisMinute += 1;
    return client.controlMessagesThisMinute <= WS_CONTROL_LIMIT_PER_MINUTE;
  }

  #send(client: HubClient, message: unknown): void {
    if (
      this.#isDeviceAllowed &&
      !(client.deviceId && this.#isDeviceAllowed(client.deviceId))
    ) {
      client.socket.close?.(
        WS_CLOSE_UNAUTHORIZED,
        "device session expired or revoked"
      );
      this.#drop(client, "device-revoked");
      return;
    }
    const status = client.socket.send(JSON.stringify(message));

    if (typeof status !== "number" || status > 0) {
      client.cleanSends += 1;
      client.consecutiveDrops = 0;
      return;
    }

    client.cleanSends = 0;

    if (status !== 0) {
      client.backpressuredFrames += 1;
      return;
    }

    client.droppedFrames += 1;
    client.consecutiveDrops += 1;
    if (client.consecutiveDrops >= MAX_CONSECUTIVE_DROPS) {
      client.socket.close?.(1011, "frames dropped");
      this.#drop(client, "frames-dropped");
    }
  }

  #sendError(socket: HubSocket, message: string): void {
    const frame = serverErrorSchema.parse({ message, type: "error" });
    const client = this.#find(socket);
    if (client) {
      this.#send(client, frame);
      return;
    }
    socket.send(JSON.stringify(frame));
  }
}
