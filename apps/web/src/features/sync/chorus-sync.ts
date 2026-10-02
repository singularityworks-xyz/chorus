import {
  type SequencedEvent,
  type VersionedSnapshot,
  versionedSnapshotSchema,
} from "@chorus/contracts";
import { Backoff } from "./backoff";
import {
  browserStorage,
  clearPersistedState,
  readPersistedSnapshot,
  type SequenceStorage,
  writePersistedSnapshot,
} from "./last-seq";
import { decideFrame, parseServerFrame } from "./protocol";

/**
 * The socket state machine (plan P5 task 1).
 *
 * Deliberately framework-free: React's Strict Mode mounts effects twice in
 * development, so a socket lifecycle wired straight into `useEffect` produces a
 * connect/close/connect churn on every hot reload and on every dev mount. Keeping
 * the lifecycle here means it can be driven by an injected factory and asserted
 * in a unit test with a fake socket — no DOM, no timer flakiness.
 *
 * Commands go over HTTP; state arrives here and only here. Nothing else in the
 * client owns a WebSocket.
 */

/** Close code the hub uses for an authentication failure (contracts §6.2). */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** The code a browser reports when a handshake fails outright, e.g. a 404. */
export const WS_CLOSE_ABNORMAL = 1006;

/**
 * Turns a close event into something worth showing a person.
 *
 * A browser reports a failed handshake as 1006 with no reason, which on its own
 * is indistinguishable from a network blip. When the URL was never configured
 * and this origin has no `/ws` route, saying so beats an opaque code.
 */
function describeClose(
  closeEvent: { code: number; reason?: string },
  urlIsImplicit: boolean
): string {
  if (closeEvent.reason && closeEvent.reason.length > 0) {
    return closeEvent.reason;
  }
  if (urlIsImplicit && closeEvent.code === WS_CLOSE_ABNORMAL) {
    return "no /ws endpoint on this origin — set NEXT_PUBLIC_CHORUS_WS_URL to the Chorus serve address";
  }
  return `closed ${String(closeEvent.code)}`;
}

export interface ChorusSyncState {
  /** Set when the socket drops; surfaced so the UI can show it. */
  lastError: string | null;
  /** Highest contiguously applied sequence. */
  lastSeq: number;
  /** Boards and preferences from the last snapshot, plus applied events. */
  snapshot: VersionedSnapshot | null;
  status: "connecting" | "live" | "offline" | "auth-expired";
}

export type SyncListener = (state: ChorusSyncState) => void;

export interface ChorusSyncDeps {
  cancel?: (handle: unknown) => void;
  /** How many reconnect attempts have been made — surfaced for diagnostics. */
  createSocket: (url: string) => ChorusSyncSocket;
  now?: () => number;
  random?: () => number;
  /** Injected so reconnect scheduling is deterministic under test. */
  schedule?: (fn: () => void, delayMs: number) => unknown;
  storage?: SequenceStorage | null;
  url: string;
  /**
   * Whether `url` came from an explicit configuration value.
   *
   * Same-origin `/ws` is correct when `serve` fronts the built web app, because
   * that is the same process serving `/ws` and the session cookie rides the
   * upgrade without any CORS involvement. It is *not* correct when the Next app
   * is served directly (`next dev`, `next start`): there is no `/ws` route or
   * rewrite, so the handshake 404s and the client would otherwise sit in
   * `connecting` forever with an empty workspace and no error to show.
   * `false` lets that case be reported with something actionable.
   */
  urlIsExplicit?: boolean;
}

/** The WebSocket surface this module uses — a subset on purpose. */
export interface ChorusSyncSocket {
  close: () => void;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  send: (data: string) => void;
}

export interface ChorusSyncOptions {
  /**
   * Fired once when authentication fails, then never again.
   *
   * The plan requires "exactly once" because the tempting alternative — retry
   * until the cookie works — turns a dead session into an infinite reconnect loop
   * that hammers the login endpoint.
   */
  onAuthExpired?: () => void;
  onEvent?: (event: SequencedEvent) => void;
  /**
   * Restores the snapshot persisted by a previous page load, before any traffic.
   *
   * Without this the client would come back from a reload with a cursor but no
   * state, resume from the gap, and render nothing until the next full snapshot.
   */
  onRestoredSnapshot?: (snapshot: VersionedSnapshot, seq: number) => void;
  onSnapshot?: (snapshot: VersionedSnapshot, seq: number) => void;
  onStatus?: (status: ChorusSyncState["status"]) => void;
}

export class ChorusSync {
  readonly #deps: ChorusSyncDeps;
  readonly #options: ChorusSyncOptions;
  readonly #backoff: Backoff;
  readonly #listeners = new Set<SyncListener>();

  #socket: ChorusSyncSocket | null = null;
  #reconnectHandle: unknown = null;
  #started = false;
  #authExpiredEmitted = false;
  /**
   * Suppresses duplicate handshakes.
   *
   * `visibilitychange` and `online` can fire together when a phone wakes, and
   * two in-flight `hello`s would replay the same gap twice. Read by `#connect` so
   * a second trigger cannot shadow a socket that is already open or handshaking.
   */
  #handshakeInFlight = false;

  /**
   * Latches a resync so a burst of gapped frames sends one `resync`, not one per
   * frame.
   *
   * The gap branch below leaves `lastSeq` where it was, so every frame in the
   * same flush is also a gap. A coalesce flush can carry up to 2000 frames, and
   * `resync` is not budget-exempt, so the burst would trip the hub's rate limit
   * and get the socket closed with 4429 -- turning one dropped frame into a
   * reconnect storm.
   */
  #resyncInFlight = false;

  #state: ChorusSyncState = {
    lastError: null,
    lastSeq: 0,
    snapshot: null,
    status: "offline",
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

  /**
   * Opens the socket and sends `hello`.
   *
   * Idempotent by design: a second `start()` while already connecting is a
   * no-op, which is what makes Strict Mode's double-mount safe.
   */
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

  /**
   * Repaints from the persisted snapshot, if there is a usable one.
   *
   * Best effort: a corrupt or oversized blob is ignored and the client asks for a
   * fresh snapshot instead.
   */
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
    });
    this.#options.onRestoredSnapshot?.(parsed.data, restored.seq);
  }

  /** Closes the socket and stops reconnecting. Used by the hook's cleanup. */
  stop(): void {
    this.#started = false;
    this.#clearReconnect();
    this.#closeSocket();
    this.#setState({ status: "offline" });
  }

  /**
   * Reconnects now, bypassing backoff.
   *
   * Called on `visibilitychange` to visible and on `online`. It does *not* start
   * a second connection when one is live or already handshaking.
   */
  reconnectNow(): void {
    if (this.#state.status === "auth-expired") {
      return;
    }

    const live =
      this.#socket !== null &&
      (this.#state.status === "connecting" || this.#state.status === "live");

    if (live) {
      return;
    }

    this.#clearReconnect();
    this.#backoff.reset();
    this.#connect();
  }

  /**
   * Asks the server for a fresh snapshot after a detected gap.
   *
   * The alternative — applying a frame with a hole — would leave the client
   * permanently missing whatever fell in the hole, because gap detection is a
   * safety net, not a repair mechanism.
   */
  requestResync(): void {
    if (this.#socket === null || this.#resyncInFlight) {
      return;
    }

    this.#resyncInFlight = true;
    try {
      this.#socket.send(JSON.stringify({ type: "resync" }));
    } catch {
      // A send on a closing socket throws; the close handler drives recovery.
      this.#resyncInFlight = false;
    }
  }

  /** Lets the UI report an HTTP 401 into the same auth-expired path. */
  reportUnauthorized(): void {
    this.#failAuth();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #connect(): void {
    if (!this.#started || this.#state.status === "auth-expired") {
      return;
    }
    // Never shadow a live socket. Without this, a `visibilitychange` and an
    // `online` firing together on a waking phone would leave the first socket
    // running with no handler, silently stranding the client.
    if (this.#socket !== null || this.#handshakeInFlight) {
      return;
    }

    this.#setState({ status: "connecting" });

    let socket: ChorusSyncSocket;
    try {
      socket = this.#deps.createSocket(this.#deps.url);
    } catch (error) {
      this.#setState({
        lastError: error instanceof Error ? error.message : "socket failed",
      });
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;

    socket.onopen = () => {
      // Deliberately no `#backoff.reset()` here. The TCP/WS upgrade succeeding
      // is not a healthy session: a server that accepts and then immediately
      // closes (1001 on restart, 1011 "frames dropped", 4000 pong timeout) would
      // reset the counter every time and draw from [0, 250) forever -- roughly
      // eight connect/close cycles a second, indefinitely. Backoff resets on
      // `ready`, which the hub only sends after auth succeeded.
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

    // Resume from the in-memory cursor, which is the highest sequence this
    // client has actually applied.
    //
    // Not from the persisted one. That is pinned to the last snapshot, so on a
    // reconnect within the same page load it sits far behind the applied state
    // and the hub coalesces the whole gap back into one frame -- `fromSeq=401,
    // seq=900` against an applied cursor of 600, say. That is not contiguous, so
    // gap detection would read every ordinary network blip as a hole and answer
    // it with a full snapshot. After a restore `#state.lastSeq` already equals
    // the persisted cursor, so this is correct in both cases.
    //
    // Only honoured when the snapshot it refers to is also in memory: resuming
    // from a cursor with nothing on screen would leave the client permanently
    // blank, which is worse than paying for a snapshot.
    const since = this.#state.snapshot === null ? 0 : this.#state.lastSeq;

    try {
      socket.send(JSON.stringify({ since, type: "hello" }));
    } catch {
      // Treat an undeliverable handshake as a dropped connection rather than
      // assuming the close handler will notice. Leaving `status` at
      // "connecting" with `#socket` still non-null means `reconnectNow` also
      // declines to act, which strands the client permanently blank with no
      // status change to show for it.
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
      // A frame the schema rejects is a version mismatch, not a reason to drop a
      // working socket. Ignoring it is strictly better than tearing down state.
      return;
    }

    switch (frame.type) {
      case "ready": {
        // The handshake completed. Anything the server is about to send is the
        // replay or the snapshot, and both are legitimate first traffic.
        this.#handshakeInFlight = false;
        // The only success that justifies resetting backoff: auth passed and the
        // server accepted our `since`. Resetting on `open` instead would let a
        // server that accepts-then-closes reconnect at full speed forever.
        this.#backoff.reset();
        this.#setState({ lastError: null, status: "live" });
        this.#options.onStatus?.("live");
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
        // The hub sends an application-level ping and closes a client that
        // misses two. A browser WebSocket cannot answer with a protocol-level
        // pong, and nothing in the page does it automatically — so without this
        // the server would drop every idle browser after 60 s.
        this.#sendPong();
        return;
      }

      case "viewport.sync": {
        // Ephemeral viewport state, never board state. There is deliberately no
        // `pong` case: pong is the client's reply to a ping, so the server never
        // sends one, and `serverMessageSchema` does not describe it. A pong
        // arriving from the server fails the union in `parseServerFrame`.
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
      // The close handler drives recovery.
    }
  }

  #applySnapshot(snapshot: VersionedSnapshot, seq: number): void {
    const storage = this.#deps.storage ?? browserStorage();

    // The snapshot answered the pending resync; allow another one if the next
    // gap demands it.
    this.#resyncInFlight = false;

    this.#setState({
      lastError: null,
      lastSeq: seq,
      snapshot,
      status: "live",
    });
    writePersistedSnapshot(storage, snapshot, seq);
    this.#options.onSnapshot?.(snapshot, seq);
  }

  #applyEvent(frame: SequencedEvent): void {
    const decision = decideFrame(frame, this.#state.lastSeq);

    if (decision.action === "gap") {
      // Ask rather than guess. The client's cursor is the only record of what it
      // has, so applying across a hole would make the divergence permanent.
      this.#setState({
        lastError: `gap: expected ${String(decision.expected)}, got ${String(decision.got)}`,
      });
      // Latched: a coalesce flush can carry many gapped frames, and `resync`
      // draws from the hub's command budget, so one request per frame would get
      // the socket closed.
      this.requestResync();
      return;
    }

    if (decision.action === "duplicate") {
      // The hub already skips these; a replay overlapping a snapshot would
      // otherwise re-append a transcript.
      this.#setState({ lastSeq: decision.nextSeq });
      return;
    }

    // Apply first, advance the cursor second.
    //
    // If the subscriber throws and the cursor already moved, the frame is lost
    // silently: gap detection cannot report a hole that the cursor claims it
    // has passed. Failing over to a snapshot is the recoverable answer, and it
    // does not depend on the exception reaching the WebSocket event handler.
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
    this.#clearReconnect();
    this.#closeSocket();

    // The cursor and its snapshot are cleared because they belong to the session
    // that just died. Keeping them would resume from a sequence the new session
    // has never seen.
    clearPersistedState(storage);

    this.#setState({ lastSeq: 0, status: "auth-expired" });
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

    // Detach first: closing a socket fires `onclose` synchronously in some
    // transports, which would re-enter the reconnect path while tearing down.
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;

    try {
      socket.close();
    } catch {
      // Already closed.
    }
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

/**
 * Resolves the WebSocket URL for the current deployment.
 *
 * Same-origin by default so the HttpOnly session cookie rides the upgrade
 * unassisted; the ticket path exists for proxies that strip it and is Phase 8's
 * concern to wire up.
 */
export function resolveSocketUrl(env: {
  explicit?: string | undefined;
  isSecure: boolean;
  origin: string;
}): string {
  // `.trim()` and the truthiness check matter: `.env.example` tells operators to
  // leave this unset when serve fronts the app, and `NEXT_PUBLIC_CHORUS_WS_URL=`
  // is the obvious way to do that. `""` would reach `new URL("")` and throw
  // during render, taking the whole workspace tree down.
  const explicit = env.explicit?.trim();
  const url = new URL(explicit ? explicit : env.origin);

  // An explicitly configured address keeps its own scheme. Overriding it with
  // the page's would turn `https://serve.example` into `ws://` when opened from
  // an http dev page, which a TLS-only server rejects.
  const secure = explicit
    ? url.protocol === "https:" || url.protocol === "wss:"
    : env.isSecure;

  url.protocol = secure ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}
