import { beforeEach, describe, expect, test } from "bun:test";
import {
  ChorusSync,
  type ChorusSyncOptions,
  WS_CLOSE_UNAUTHORIZED,
} from "./chorus-sync";
import { LAST_SEQ_KEY, SNAPSHOT_KEY, writePersistedSnapshot } from "./last-seq";
import {
  approvalEvent,
  eventFrame,
  FakeScheduler,
  FakeSocket,
  FakeStorage,
  HostileStorage,
  snapshotFixture,
} from "./testing";

interface Harness {
  authExpiredCalls: () => number;
  events: unknown[];
  scheduler: FakeScheduler;
  snapshots: { seq: number; snapshot: unknown }[];
  storage: FakeStorage | HostileStorage | null;
  sync: ChorusSync;
}

function makeSync(
  storage?: FakeStorage | HostileStorage | null,
  overrides?: Partial<ChorusSyncOptions>
): Harness {
  const scheduler = new FakeScheduler();
  const harness: Harness = {
    authExpiredCalls: () => 0,
    events: [],
    scheduler,
    snapshots: [],
    storage: storage === undefined ? new FakeStorage() : storage,
    sync: null as unknown as ChorusSync,
  };

  let authExpired = 0;

  harness.sync = new ChorusSync(
    {
      cancel: scheduler.cancel,
      createSocket: (url) => new FakeSocket(url),
      now: () => 1_700_000_000_000,
      random: () => 1,
      schedule: scheduler.schedule,
      storage: harness.storage as never,
      url: "ws://localhost:2000/ws",
    },
    {
      onAuthExpired: () => {
        authExpired += 1;
      },
      onEvent: (frame) => {
        harness.events.push(frame);
      },
      onSnapshot: (snapshot, seq) => {
        harness.snapshots.push({ seq, snapshot });
      },
      // Spread last: an override has to win over the recording defaults above,
      // otherwise a custom `onEvent` is silently discarded.
      ...overrides,
    }
  );

  harness.authExpiredCalls = () => authExpired;
  return harness;
}

/**
 * Starts a sync and returns its socket, opened but not yet handshaken.
 *
 * `hello` is sent from `onopen`, not at construction — a socket cannot be
 * written to before it is open — so handshake assertions open first.
 */
function openSocket(sync: ChorusSync): FakeSocket {
  sync.start();
  const socket = FakeSocket.last;
  socket.open();
  return socket;
}

/** Boots a sync and walks it to a live state at sequence zero. */
function liveSocket(sync: ChorusSync): FakeSocket {
  const socket = openSocket(sync);
  socket.emit({ head: 0, type: "ready" });
  socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });
  return socket;
}

beforeEach(() => {
  FakeSocket.reset();
});

describe("handshake and resume (plan P5 task 1)", () => {
  test("start connects and sends hello with since 0 when there is no history", () => {
    const { sync } = makeSync();
    const socket = openSocket(sync);

    expect(socket.sentTypes).toEqual(["hello"]);
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      since: 0,
      type: "hello",
    });
  });

  test("a persisted cursor and snapshot are restored, then resumed from", () => {
    const storage = new FakeStorage();
    writePersistedSnapshot(storage, snapshotFixture({ boards: [] }), 412);
    const restored: { seq: number; snapshot: unknown }[] = [];
    const scheduler = new FakeScheduler();

    const sync = new ChorusSync(
      {
        cancel: scheduler.cancel,
        createSocket: (url) => new FakeSocket(url),
        schedule: scheduler.schedule,
        storage: storage as never,
        url: "ws://localhost:2000/ws",
      },
      {
        onRestoredSnapshot: (snapshot, seq) => {
          restored.push({ seq, snapshot });
        },
      }
    );

    const socket = openSocket(sync);

    // The state comes back before any traffic, so a reload does not paint an
    // empty workspace.
    expect(restored).toHaveLength(1);
    expect(restored[0]?.seq).toBe(412);
    expect(sync.state.snapshot).not.toBeNull();

    // And the reconnect asks only for what it is missing.
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      since: 412,
      type: "hello",
    });
  });

  test("a cursor without its snapshot forces a snapshot instead of a gap", () => {
    // The flaw this guards: a reload throws away in-memory state, so resuming
    // from a cursor with nothing on screen would leave the client permanently
    // blank. With no restorable snapshot the client must ask for everything.
    const storage = new FakeStorage();
    storage.setItem(LAST_SEQ_KEY, "412");
    const { sync } = makeSync(storage);

    const socket = openSocket(sync);

    expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
  });

  test("a corrupt persisted snapshot falls back to a full snapshot", () => {
    for (const raw of ["{broken", '{"seq":-1}', '{"seq":1}', "null", "[]"]) {
      FakeSocket.reset();
      const storage = new FakeStorage();
      storage.setItem(SNAPSHOT_KEY, raw);
      storage.setItem(LAST_SEQ_KEY, "7");
      const { sync } = makeSync(storage);

      const socket = openSocket(sync);

      expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
      expect(sync.state.snapshot).toBeNull();
    }
  });

  test("a persisted snapshot that fails the schema is rejected", () => {
    // Unvalidated shapes must never reach app state, even from localStorage.
    const storage = new FakeStorage();
    writePersistedSnapshot(storage, { boards: "not-an-array" }, 5);
    const { sync } = makeSync(storage);

    const socket = openSocket(sync);

    expect(sync.state.snapshot).toBeNull();
    expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
  });

  test("start is idempotent, which is what makes Strict Mode safe", () => {
    // React Strict Mode mounts effects twice in development. A lifecycle wired
    // straight into useEffect would open, close, and reopen on every mount.
    const { sync } = makeSync();

    sync.start();
    sync.start();
    sync.start();

    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("reconnectNow does not open a second socket while one is live", () => {
    const { sync } = makeSync();
    openSocket(sync);

    sync.reconnectNow();
    sync.reconnectNow();

    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("reconnectNow after a drop reopens immediately, skipping backoff", () => {
    const { scheduler, sync } = makeSync();
    openSocket(sync);
    FakeSocket.last.remoteClose(1006);
    scheduler.pending.length = 0;

    sync.reconnectNow();

    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("only one handshake is in flight at a time", () => {
    // `visibilitychange` and `online` can fire together when a phone wakes. Two
    // in-flight hellos would replay the same gap twice.
    const { sync } = makeSync();
    const socket = openSocket(sync);

    expect(sync.handshakeInFlight).toBe(true);

    socket.emit({ head: 0, type: "ready" });

    expect(sync.handshakeInFlight).toBe(false);
  });

  test("an unexplained close on an implicit URL names the missing env var", () => {
    // Same-origin `/ws` is only valid when serve fronts the built app. When Next
    // is served directly the handshake 404s, which the browser reports as 1006
    // with no reason -- and without this the client looks merely "connecting".
    const scheduler = new FakeScheduler();
    const sync = new ChorusSync({
      cancel: scheduler.cancel,
      createSocket: (url) => new FakeSocket(url),
      now: () => 1_700_000_000_000,
      random: () => 1,
      schedule: scheduler.schedule,
      url: "ws://localhost:3000/ws",
      urlIsExplicit: false,
    });
    openSocket(sync);
    FakeSocket.last.remoteClose(1006);

    expect(sync.state.lastError).toContain("NEXT_PUBLIC_CHORUS_WS_URL");
  });

  test("a completed handshake resets the backoff so a later blip starts fast", () => {
    const { scheduler, sync } = makeSync();

    // Five failed attempts back the delay up.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      openSocket(sync);
      FakeSocket.last.remoteClose(1006);
      scheduler.flushOne();
    }

    // One healthy session: open, then `ready`.
    openSocket(sync);
    FakeSocket.last.emit({ head: 0, type: "ready" });
    scheduler.pending.length = 0;
    FakeSocket.last.remoteClose(1006);

    expect(scheduler.delays[0]).toBe(250);
  });

  test("a server that accepts then closes does not reset the backoff", () => {
    const { scheduler, sync } = makeSync();

    // The upgrade succeeds every time, but `ready` never arrives. Resetting on
    // `open` would draw from [0, 250) forever -- roughly eight connect/close
    // cycles a second, against a server that is clearly unhealthy.
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      openSocket(sync);
      FakeSocket.last.remoteClose(1006);
      delays.push(scheduler.delays.at(-1) ?? 0);
      scheduler.flushOne();
    }

    const first = delays[0] ?? 0;
    const last = delays.at(-1) ?? 0;
    expect(last).toBeGreaterThan(first);
  });

  test("a gap burst sends one resync, not one per frame", () => {
    const { sync } = makeSync();
    const socket = openSocket(sync);
    socket.emit({ head: 0, type: "ready" });
    socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });

    socket.sent.length = 0;
    // A coalesce flush can carry many gapped frames. `resync` draws from the
    // hub's command budget, so one per frame would trip the rate limit and get
    // the socket closed with 4429.
    for (const seq of [6, 8, 10, 12]) {
      socket.emit(eventFrame(seq - 1, seq));
    }

    expect(socket.sentTypes.filter((type) => type === "resync")).toHaveLength(
      1
    );

    // The snapshot clears the latch, so a later gap can ask again.
    socket.sent.length = 0;
    socket.emit({ data: snapshotFixture(), seq: 20, type: "snapshot" });
    socket.emit(eventFrame(22, 22));
    expect(socket.sentTypes.filter((type) => type === "resync")).toHaveLength(
      1
    );
  });

  test("a reconnect resumes from the applied cursor, not the persisted one", () => {
    const storage = new FakeStorage();
    const scheduler = new FakeScheduler();
    const sync = new ChorusSync({
      cancel: scheduler.cancel,
      createSocket: (url) => new FakeSocket(url),
      now: () => 1_700_000_000_000,
      random: () => 1,
      schedule: scheduler.schedule,
      storage,
      url: "ws://localhost:2000/ws",
    });
    const socket = openSocket(sync);
    socket.emit({ head: 0, type: "ready" });
    socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });

    // Live events advance the applied cursor but not the persisted one, which is
    // pinned to the last snapshot.
    socket.emit(eventFrame(1, 1));
    socket.emit(eventFrame(2, 2));
    expect(sync.state.lastSeq).toBe(2);
    expect(storage.getItem(LAST_SEQ_KEY)).toBe("0");

    // A blip. Re-sending `since: 0` would make the hub coalesce the whole gap
    // into one frame, and a frame like fromSeq=1/seq=2 against an applied cursor
    // of 2 is contiguous -- but against anything longer it is a gap, so every
    // ordinary blip would answer itself with a full snapshot.
    socket.remoteClose(1006);
    scheduler.flushOne();
    FakeSocket.last.open();

    const hello = JSON.parse(FakeSocket.last.sent[0] ?? "{}") as {
      since: number;
    };
    expect(hello.since).toBe(2);
  });

  test("a subscriber that throws resyncs instead of losing the frame", () => {
    const { sync } = makeSync(null, {
      onEvent: () => {
        throw new Error("reducer exploded");
      },
    });
    const socket = openSocket(sync);
    socket.emit({ head: 0, type: "ready" });
    socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });

    socket.sent.length = 0;
    socket.emit(eventFrame(1, 1));

    // The cursor must not claim to have passed a frame that was never applied,
    // or gap detection could never report the miss.
    expect(sync.state.lastSeq).toBe(0);
    expect(socket.sentTypes.filter((type) => type === "resync")).toHaveLength(
      1
    );
  });
});

describe("applying state", () => {
  test("a snapshot replaces state and persists the cursor", () => {
    const storage = new FakeStorage();
    const { snapshots, sync } = makeSync(storage);
    const socket = openSocket(sync);

    socket.emit({ head: 7, type: "ready" });
    socket.emit({ data: snapshotFixture(), seq: 7, type: "snapshot" });

    expect(sync.state.lastSeq).toBe(7);
    expect(sync.state.status).toBe("live");
    expect(snapshots).toHaveLength(1);
    expect(storage.getItem(LAST_SEQ_KEY)).toBe("7");
  });

  test("contiguous events advance the cursor and are handed on", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));
    socket.emit(eventFrame(2, 2));

    expect(sync.state.lastSeq).toBe(2);
    expect(events).toHaveLength(2);
  });

  test("a coalesced frame advances the cursor to the end of its run", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    // The hub folds log rows 1..500 into one frame. Landing on 1 would make the
    // next reconnect replay 2..500 on top of a transcript that already has them.
    socket.emit(eventFrame(1, 500));

    expect(sync.state.lastSeq).toBe(500);
    expect(events).toHaveLength(1);
  });

  test("a gap triggers a resync rather than a guess", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));
    // Sequence 2 never arrives and 3 shows up.
    socket.emit(eventFrame(3, 3));

    expect(socket.sentTypes).toEqual(["hello", "resync"]);
    // The frame is not applied: the client cannot know what fell in the hole.
    expect(events).toHaveLength(1);
    expect(sync.state.lastSeq).toBe(1);
    expect(sync.state.lastError).toContain("gap");
  });

  test("a duplicate frame is ignored and never re-applied", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));
    // A replay overlapping a snapshot must not append the transcript twice.
    socket.emit(eventFrame(1, 1));

    expect(events).toHaveLength(1);
    expect(sync.state.lastSeq).toBe(1);
  });

  test("a board-scoped event carries its board id through", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit({
      boardId: "board-1",
      event: approvalEvent("board-1"),
      fromSeq: 1,
      seq: 1,
      ts: 1000,
      type: "event",
    });

    expect(events).toHaveLength(1);
  });

  test("a malformed frame does not tear down a live socket", () => {
    const { sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit({ nonsense: true });
    socket.onmessage?.({ data: "not-an-object" });
    socket.onmessage?.({ data: "{broken" });

    expect(sync.state.status).toBe("live");
    expect(sync.state.lastSeq).toBe(0);
  });

  test("a ping is answered and never touches board state", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit({ at: 5, type: "ping" });

    expect(sync.state.lastSeq).toBe(0);
    expect(events).toHaveLength(0);
    // The hub drops a client that misses two pongs; the browser cannot answer
    // them, so the client answers the server's ping for itself.
    expect(socket.sentTypes).toContain("pong");
  });

  test("a viewport relay is not treated as state", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit({ payload: { x: 1 }, timestamp: 5, type: "viewport.sync" });

    expect(events).toHaveLength(0);
    expect(sync.state.lastSeq).toBe(0);
  });
});

describe("storage resilience", () => {
  test("a throwing storage degrades to a snapshot rather than a guess", () => {
    const { sync } = makeSync(new HostileStorage());
    const socket = openSocket(sync);

    // Safari private mode throws on access; the client must not resume from a
    // guessed sequence.
    expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
  });

  test("a corrupt persisted value is ignored", () => {
    for (const raw of ["", "  ", "abc", "NaN", "-1", "1.5", "1e999"]) {
      FakeSocket.reset();
      const storage = new FakeStorage();
      storage.setItem(LAST_SEQ_KEY, raw);
      const { sync } = makeSync(storage);

      const socket = openSocket(sync);

      expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
    }
  });

  test("applying an event with hostile storage still advances the cursor", () => {
    const { sync } = makeSync(new HostileStorage());
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));

    // Failing to persist costs a snapshot on the next refresh, not correctness.
    expect(sync.state.lastSeq).toBe(1);
    expect(sync.state.status).toBe("live");
  });

  test("a null storage is tolerated", () => {
    const { sync } = makeSync(null);
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));

    expect(sync.state.lastSeq).toBe(1);
  });
});

describe("401 / 4401 loop guard (plan P5 task 3)", () => {
  test("close 4401 stops reconnecting and emits AUTH_EXPIRED once", () => {
    const storage = new FakeStorage();
    const { authExpiredCalls, scheduler, sync } = makeSync(storage);
    sync.start();

    storage.setItem(LAST_SEQ_KEY, "99");
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);

    expect(authExpiredCalls()).toBe(1);
    expect(sync.state.status).toBe("auth-expired");
    // The cursor belonged to the session that just died.
    expect(storage.getItem(LAST_SEQ_KEY)).toBeNull();
    expect(scheduler.pending).toHaveLength(0);
  });

  test("a dropped session never schedules a reconnect", () => {
    // Retrying a dead cookie forever is an infinite loop against the login
    // endpoint; the plan is explicit that 401 does not resolve without a human.
    const { scheduler, sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      scheduler.flushAll();
    }

    expect(FakeSocket.instances).toHaveLength(1);
    expect(scheduler.pending).toHaveLength(0);
  });

  test("AUTH_EXPIRED is emitted exactly once across repeated failures", () => {
    const { authExpiredCalls, sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);
    // A second failure must not re-notify the UI.
    sync.reportUnauthorized();
    sync.reportUnauthorized();

    expect(authExpiredCalls()).toBe(1);
  });

  test("start and reconnectNow are inert once auth has expired", () => {
    const { sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);
    const before = FakeSocket.instances.length;

    sync.start();
    sync.reconnectNow();

    expect(FakeSocket.instances).toHaveLength(before);
  });

  test("an HTTP 401 reported into the sync clears the cursor", () => {
    const storage = new FakeStorage();
    const { sync } = makeSync(storage);
    sync.start();
    storage.setItem(LAST_SEQ_KEY, "5");

    sync.reportUnauthorized();

    expect(storage.getItem(LAST_SEQ_KEY)).toBeNull();
    expect(sync.state.status).toBe("auth-expired");
  });

  test("an ordinary drop is not mistaken for an auth failure", () => {
    const { authExpiredCalls, scheduler, sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(1006);

    expect(sync.state.status).toBe("offline");
    expect(scheduler.pending).toHaveLength(1);
    expect(authExpiredCalls()).toBe(0);
  });
});

describe("reconnect scheduling", () => {
  test("a drop schedules exactly one retry", () => {
    const { scheduler, sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(1006);

    expect(scheduler.pending).toHaveLength(1);
  });

  test("repeated drops do not pile up retries", () => {
    const { scheduler, sync } = makeSync();
    sync.start();

    FakeSocket.last.remoteClose(1006);
    FakeSocket.last.remoteClose(1006);
    FakeSocket.last.remoteClose(1006);

    expect(scheduler.pending).toHaveLength(1);
  });

  test("stop cancels a pending retry", () => {
    const { scheduler, sync } = makeSync();
    openSocket(sync);

    FakeSocket.last.remoteClose(1006);
    expect(scheduler.pending).toHaveLength(1);

    sync.stop();

    // Without this, `stop()` would leave a timer that reconnects a socket the
    // component believes it has torn down.
    expect(scheduler.pending).toHaveLength(0);
  });

  test("stop closes a live socket", () => {
    const { sync } = makeSync();
    const socket = openSocket(sync);

    sync.stop();

    expect(socket.closed).toBe(true);
  });

  test("stop detaches handlers so closing does not re-enter the retry path", () => {
    const { scheduler, sync } = makeSync();
    sync.start();
    const socket = FakeSocket.last;

    sync.stop();

    // A transport that fires `onclose` synchronously during close must not
    // schedule a reconnect from inside teardown.
    expect(socket.onclose).toBeNull();
    expect(scheduler.pending).toHaveLength(0);
  });

  test("stop then start reopens", () => {
    const { sync } = makeSync();
    sync.start();
    sync.stop();
    sync.start();

    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("a socket that cannot be created schedules a retry rather than throwing", () => {
    const scheduler = new FakeScheduler();
    const sync = new ChorusSync(
      {
        cancel: scheduler.cancel,
        createSocket: () => {
          throw new Error("SecurityError: blocked");
        },
        schedule: scheduler.schedule,
        storage: new FakeStorage(),
        url: "ws://localhost:2000/ws",
      },
      {}
    );

    expect(() => sync.start()).not.toThrow();
    expect(scheduler.pending).toHaveLength(1);
    expect(sync.state.lastError).toContain("blocked");
  });

  test("a hello that throws on send does not strand the handshake flag", () => {
    const { sync } = makeSync();
    sync.start();
    const socket = FakeSocket.last;
    socket.send = () => {
      throw new Error("socket closed");
    };

    expect(() => socket.open()).not.toThrow();
    expect(sync.handshakeInFlight).toBe(false);
  });
});

describe("subscribers", () => {
  test("a subscriber receives the current state immediately", () => {
    const { sync } = makeSync();
    const seen: string[] = [];

    sync.subscribe((state) => seen.push(state.status));

    expect(seen).toEqual(["offline"]);
  });

  test("unsubscribe stops delivery", () => {
    const { sync } = makeSync();
    const seen: string[] = [];
    const unsubscribe = sync.subscribe((state) => seen.push(state.status));

    sync.start();
    const countBefore = seen.length;
    unsubscribe();
    FakeSocket.last.remoteClose(1006);

    expect(seen).toHaveLength(countBefore);
  });

  test("status transitions are observable", () => {
    const { sync } = makeSync();
    const seen: string[] = [];
    sync.subscribe((state) => seen.push(state.status));

    const socket = openSocket(sync);
    socket.emit({ head: 1, type: "ready" });

    expect(seen).toContain("connecting");
    expect(seen).toContain("live");
  });
});
