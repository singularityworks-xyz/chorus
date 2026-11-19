import {
  type SequencedEvent,
  type VersionedSnapshot,
  versionedSnapshotSchema,
  WS_CLOSE_UNAUTHORIZED,
} from "@chorus/contracts";
import { Backoff } from "./backoff";
import { decideFrame, parseServerFrame } from "./protocol";
import {
  browserStorage,
  clearPersistedState,
  readPersistedSnapshot,
  writePersistedSnapshot,
} from "./snapshot-storage";
import { SocketAuthenticationExpiredError } from "./socket-credentials";
import { describeClose } from "./socket-url";
import type {
  ChorusSyncDeps,
  ChorusSyncOptions,
  ChorusSyncSocket,
  ChorusSyncState,
  SyncListener,
} from "./types";

export class ChorusSync {
  readonly #deps: ChorusSyncDeps;
  readonly #options: ChorusSyncOptions;
  readonly #backoff: Backoff;
  readonly #listeners = new Set<SyncListener>();

  #socket: ChorusSyncSocket | null = null;
  #reconnectHandle: unknown = null;
  #started = false;
  #authExpiredEmitted = false;
  #handshakeInFlight = false;
  #socketUrlPreparationInFlight = false;
  #connectionGeneration = 0;
  #connectionWorkspaceId: string | null = null;

  // One resync covers every gap in the same event burst.
  #resyncInFlight = false;

  #state: ChorusSyncState = {
    lastError: null,
    lastSeq: 0,
    snapshot: null,
    status: "offline",
    workspaceId: null,
  };

  constructor(deps: ChorusSyncDeps, options: ChorusSyncOptions = {}) {
    this.#deps = deps;
    this.#options = options;
    this.#backoff = new Backoff({
      random: deps.random,
    });
  }

  get state(): ChorusSyncState {
    return this.#state;
  }

  get reconnectAttempts(): number {
    return this.#backoff.attempt;
  }

  get handshakeInFlight(): boolean {
    return this.#handshakeInFlight;
  }

  subscribe(listener: SyncListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;

    if (this.#state.status === "auth-expired") {
      return;
    }

    this.#restorePersisted();
    this.#connect();
  }

  #restorePersisted(): void {
    const storage = this.#deps.storage ?? browserStorage();
    const restored = readPersistedSnapshot(storage);

    if (!restored) {
      return;
    }

    const parsed = versionedSnapshotSchema.safeParse(restored.snapshot);
    if (!parsed.success) {
      return;
    }

    this.#setState({
      lastError: null,
      lastSeq: restored.seq,
      snapshot: parsed.data,
      status: "connecting",
      workspaceId: restored.workspaceId,
    });
    this.#options.onRestoredSnapshot?.(parsed.data, restored.seq);
  }

  stop(): void {
    this.#started = false;
    this.#invalidateSocketUrlPreparation();
    this.#clearReconnect();
    this.#closeSocket();
    this.#setState({ status: "offline" });
  }

  reconnectNow(): void {
    if (this.#state.status === "auth-expired") {
      return;
    }

    const live =
      this.#socket !== null &&
      (this.#state.status === "connecting" || this.#state.status === "live");

    if (live || this.#socketUrlPreparationInFlight) {
      return;
    }

    this.#clearReconnect();
    this.#backoff.reset();
    this.#connect();
  }

  networkOffline(): void {
    if (this.#state.status === "auth-expired") {
      return;
    }

    this.#clearReconnect();
    this.#invalidateSocketUrlPreparation();
    this.#closeSocket();
    this.#setState({ lastError: "offline", status: "offline" });
  }

  requestResync(): void {
    if (this.#socket === null || this.#resyncInFlight) {
      return;
    }

    this.#resyncInFlight = true;
    try {
      this.#socket.send(JSON.stringify({ type: "resync" }));
    } catch {
      this.#resyncInFlight = false;
    }
  }

  reportUnauthorized(): void {
    this.#failAuth();
  }

  #connect(): void {
    if (!this.#started || this.#state.status === "auth-expired") {
      return;
    }
    if (
      this.#socket !== null ||
      this.#handshakeInFlight ||
      this.#socketUrlPreparationInFlight
    ) {
      return;
    }

    this.#connectionWorkspaceId = null;
    this.#setState({ status: "connecting" });

    const prepareSocketUrl = this.#deps.prepareSocketUrl;
    if (prepareSocketUrl) {
      const generation = ++this.#connectionGeneration;
      this.#socketUrlPreparationInFlight = true;
      Promise.resolve()
        .then(() => prepareSocketUrl(this.#deps.url))
        .then((url) => {
          if (!this.#isCurrentPreparation(generation)) {
            return;
          }
          this.#socketUrlPreparationInFlight = false;
          this.#openSocket(url);
        })
        .catch((error: unknown) => {
          if (!this.#isCurrentPreparation(generation)) {
            return;
          }
          this.#socketUrlPreparationInFlight = false;
          if (error instanceof SocketAuthenticationExpiredError) {
            this.#failAuth();
            return;
          }

          this.#setState({
            lastError:
              error instanceof Error
                ? error.message
                : "socket credentials failed",
            status: "offline",
          });
          this.#scheduleReconnect();
        });
      return;
    }

    this.#openSocket(this.#deps.url);
  }

  #openSocket(url: string): void {
    if (!this.#started || this.#state.status === "auth-expired") {
      return;
    }

    let socket: ChorusSyncSocket;
    try {
      socket = this.#deps.createSocket(url);
    } catch (error) {
      this.#setState({
        lastError: error instanceof Error ? error.message : "socket failed",
      });
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;

    socket.onopen = () => {
      this.#handshakeInFlight = true;
      this.#sendHello();
    };

    socket.onmessage = (event) => {
      this.#handleMessage(event.data);
    };

    socket.onerror = () => {
      this.#setState({ lastError: "socket error" });
    };

    socket.onclose = (closeEvent) => {
      this.#handshakeInFlight = false;
      this.#resyncInFlight = false;
      this.#socket = null;

      if (closeEvent.code === WS_CLOSE_UNAUTHORIZED) {
        this.#failAuth();
        return;
      }

      this.#setState({
        lastError: describeClose(
          closeEvent,
          this.#deps.urlIsExplicit === false
        ),
        status: "offline",
      });
      this.#scheduleReconnect();
    };
  }

  #sendHello(): void {
    const socket = this.#socket;
    if (socket === null) {
      return;
    }
    const workspaceId = this.#state.workspaceId;
    // Storage stays at the snapshot cursor; resume from the applied in-memory cursor.
    const since =
      this.#state.snapshot === null || workspaceId === null
        ? 0
        : this.#state.lastSeq;

    try {
      socket.send(
        JSON.stringify({
          ...(workspaceId === null ? {} : { workspaceId }),
          since,
          type: "hello",
        })
      );
    } catch {
      this.#handshakeInFlight = false;
      this.#closeSocket();
      this.#setState({ lastError: "hello failed", status: "offline" });
      this.#scheduleReconnect();
      return;
    }
  }

  #handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }

    const frame = parseServerFrame(data);
    if (frame === null) {
      return;
    }

    switch (frame.type) {
      case "ready": {
        this.#handshakeInFlight = false;
        this.#connectionWorkspaceId = frame.workspaceId ?? null;
        // Reset only after the authenticated handshake is ready.
        this.#backoff.reset();
        this.#setState({ lastError: null, status: "live" });
        this.#options.onStatus?.("live");
        if (this.#connectionWorkspaceId === null) {
          this.requestResync();
        }
        return;
      }

      case "snapshot": {
        this.#applySnapshot(frame.data, frame.seq);
        return;
      }

      case "event": {
        this.#applyEvent(frame);
        return;
      }

      case "ping": {
        this.#sendPong();
        return;
      }

      case "viewport.sync": {
        return;
      }

      case "error": {
        this.#setState({ lastError: frame.message });
        return;
      }

      default:
        return;
    }
  }

  #sendPong(): void {
    const socket = this.#socket;
    if (socket === null) {
      return;
    }

    try {
      socket.send(JSON.stringify({ type: "pong" }));
    } catch {
      return;
    }
  }

  #applySnapshot(snapshot: VersionedSnapshot, seq: number): void {
    const storage = this.#deps.storage ?? browserStorage();
    this.#resyncInFlight = false;

    this.#setState({
      lastError: null,
      lastSeq: seq,
      snapshot,
      status: "live",
      workspaceId: this.#connectionWorkspaceId,
    });
    writePersistedSnapshot(storage, snapshot, seq, this.#connectionWorkspaceId);
    this.#options.onSnapshot?.(snapshot, seq);
  }

  #applyEvent(frame: SequencedEvent): void {
    const decision = decideFrame(frame, this.#state.lastSeq);

    if (decision.action === "gap") {
      this.#setState({
        lastError: `gap: expected ${String(decision.expected)}, got ${String(decision.got)}`,
      });
      this.requestResync();
      return;
    }

    if (decision.action === "duplicate") {
      this.#setState({ lastSeq: decision.nextSeq });
      return;
    }
    // Listener failures must not advance the resume cursor.
    try {
      this.#options.onEvent?.(frame);
    } catch (error) {
      this.#setState({
        lastError: `apply failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.requestResync();
      return;
    }

    this.#setState({ lastError: null, lastSeq: decision.nextSeq });
  }

  #failAuth(): void {
    const storage = this.#deps.storage ?? browserStorage();

    this.#started = false;
    this.#invalidateSocketUrlPreparation();
    this.#clearReconnect();
    this.#closeSocket();
    clearPersistedState(storage);

    this.#setState({ lastSeq: 0, status: "auth-expired", workspaceId: null });
    this.#options.onStatus?.("auth-expired");

    if (!this.#authExpiredEmitted) {
      this.#authExpiredEmitted = true;
      this.#options.onAuthExpired?.();
    }
  }

  #scheduleReconnect(): void {
    if (!this.#started || this.#state.status === "auth-expired") {
      return;
    }
    if (this.#reconnectHandle !== null) {
      return;
    }

    const delay = this.#backoff.next();
    const schedule = this.#deps.schedule ?? defaultSchedule;

    this.#reconnectHandle = schedule(() => {
      this.#reconnectHandle = null;
      this.#connect();
    }, delay);
  }

  #clearReconnect(): void {
    if (this.#reconnectHandle === null) {
      return;
    }

    const cancel = this.#deps.cancel ?? defaultCancel;
    cancel(this.#reconnectHandle);
    this.#reconnectHandle = null;
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#handshakeInFlight = false;
    this.#resyncInFlight = false;
    if (socket === null) {
      return;
    }
    // Some transports fire `onclose` synchronously during teardown.
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;

    try {
      socket.close();
    } catch {
      return;
    }
  }

  #isCurrentPreparation(generation: number): boolean {
    return (
      this.#started &&
      this.#socketUrlPreparationInFlight &&
      generation === this.#connectionGeneration
    );
  }

  #invalidateSocketUrlPreparation(): void {
    this.#connectionGeneration += 1;
    this.#socketUrlPreparationInFlight = false;
  }

  #setState(patch: Partial<ChorusSyncState>): void {
    this.#state = { ...this.#state, ...patch };

    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }
}

function defaultSchedule(fn: () => void, delayMs: number): unknown {
  return setTimeout(fn, delayMs);
}

function defaultCancel(handle: unknown): void {
  if (typeof handle === "number" || typeof handle === "object") {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
