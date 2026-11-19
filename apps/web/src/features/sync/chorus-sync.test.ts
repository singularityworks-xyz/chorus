import { beforeEach, describe, expect, test } from "bun:test";
import { WS_CLOSE_UNAUTHORIZED } from "@chorus/contracts";
import { ChorusSync } from "./chorus-sync";
import {
  LEGACY_LAST_SEQ_KEY,
  readPersistedSnapshot,
  SNAPSHOT_KEY,
  writePersistedSnapshot,
} from "./snapshot-storage";
import { SocketAuthenticationExpiredError } from "./socket-credentials";
import {
  approvalEvent,
  eventFrame,
  FakeScheduler,
  FakeSocket,
  FakeStorage,
  HostileStorage,
  snapshotFixture,
} from "./testing";
import type { ChorusSyncOptions } from "./types";

interface Harness {
  authExpiredCalls: () => number;
  events: unknown[];
  scheduler: FakeScheduler;
  snapshots: { seq: number; snapshot: unknown }[];
  storage: FakeStorage | HostileStorage | null;
  sync: ChorusSync;
}

const TEST_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function makeSync(
  storage?: FakeStorage | HostileStorage | null,
  overrides?: Partial<ChorusSyncOptions>
): Harness {
  const scheduler = new FakeScheduler();
  const resolvedStorage = storage === undefined ? new FakeStorage() : storage;
  const events: unknown[] = [];
  const snapshots: { seq: number; snapshot: unknown }[] = [];
  let authExpired = 0;

  const sync = new ChorusSync(
    {
      cancel: scheduler.cancel,
      createSocket: (url) => new FakeSocket(url),
      random: () => 1,
      schedule: scheduler.schedule,
      storage: resolvedStorage,
      url: "ws://localhost:2000/ws",
    },
    {
      onAuthExpired: () => {
        authExpired += 1;
      },
      onEvent: (frame) => {
        events.push(frame);
      },
      onSnapshot: (snapshot, seq) => {
        snapshots.push({ seq, snapshot });
      },
      ...overrides,
    }
  );

  return {
    authExpiredCalls: () => authExpired,
    events,
    scheduler,
    snapshots,
    storage: resolvedStorage,
    sync,
  };
}

function openSocket(sync: ChorusSync): FakeSocket {
  sync.start();
  const socket = FakeSocket.last;
  socket.open();
  return socket;
}

function liveSocket(sync: ChorusSync): FakeSocket {
  const socket = openSocket(sync);
  socket.emit({
    head: 0,
    type: "ready",
    workspaceId: TEST_WORKSPACE_ID,
  });
  socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });
  return socket;
}

async function flushPromiseQueue(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  FakeSocket.reset();
});

describe("handshake and resume", () => {
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
    writePersistedSnapshot(
      storage,
      snapshotFixture({ boards: [] }),
      412,
      TEST_WORKSPACE_ID
    );
    const restored: { seq: number; snapshot: unknown }[] = [];
    const scheduler = new FakeScheduler();

    const sync = new ChorusSync(
      {
        cancel: scheduler.cancel,
        createSocket: (url) => new FakeSocket(url),
        schedule: scheduler.schedule,
        storage,
        url: "ws://localhost:2000/ws",
      },
      {
        onRestoredSnapshot: (snapshot, seq) => {
          restored.push({ seq, snapshot });
        },
      }
    );

    const socket = openSocket(sync);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.seq).toBe(412);
    expect(sync.state.snapshot).not.toBeNull();
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      since: 412,
      type: "hello",
      workspaceId: TEST_WORKSPACE_ID,
    });
  });

  test("a changed workspace replaces a same-sequence cached snapshot", () => {
    const storage = new FakeStorage();
    const previous = snapshotFixture({ boards: [] });
    writePersistedSnapshot(storage, previous, 9, TEST_WORKSPACE_ID);
    const { sync } = makeSync(storage);
    const socket = openSocket(sync);

    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      since: 9,
      type: "hello",
      workspaceId: TEST_WORKSPACE_ID,
    });

    socket.emit({
      head: 9,
      type: "ready",
      workspaceId: REPLACEMENT_WORKSPACE_ID,
    });
    const replacement = snapshotFixture({ boards: [] });
    socket.emit({ data: replacement, seq: 9, type: "snapshot" });

    expect(sync.state.workspaceId).toBe(REPLACEMENT_WORKSPACE_ID);
    expect(sync.state.snapshot).toEqual(replacement);
    expect(readPersistedSnapshot(storage)?.workspaceId).toBe(
      REPLACEMENT_WORKSPACE_ID
    );
  });

  test("an older server without workspace identity is explicitly resynced", () => {
    const storage = new FakeStorage();
    writePersistedSnapshot(
      storage,
      snapshotFixture({ boards: [] }),
      9,
      TEST_WORKSPACE_ID
    );
    const { sync } = makeSync(storage);
    const socket = openSocket(sync);

    socket.emit({ head: 9, type: "ready" });
    expect(socket.sentTypes).toEqual(["hello", "resync"]);

    socket.emit({
      data: snapshotFixture({ boards: [] }),
      seq: 9,
      type: "snapshot",
    });
    expect(sync.state.workspaceId).toBeNull();
    expect(readPersistedSnapshot(storage)?.workspaceId).toBeNull();
  });

  test("a cursor without its snapshot forces a snapshot instead of a gap", () => {
    const storage = new FakeStorage();
    storage.setItem(LEGACY_LAST_SEQ_KEY, "412");
    const { sync } = makeSync(storage);

    const socket = openSocket(sync);

    expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
  });

  test("a corrupt persisted snapshot falls back to a full snapshot", () => {
    for (const raw of ["{broken", '{"seq":-1}', '{"seq":1}', "null", "[]"]) {
      FakeSocket.reset();
      const storage = new FakeStorage();
      storage.setItem(SNAPSHOT_KEY, raw);
      storage.setItem(LEGACY_LAST_SEQ_KEY, "7");
      const { sync } = makeSync(storage);

      const socket = openSocket(sync);

      expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
      expect(sync.state.snapshot).toBeNull();
    }
  });

  test("a persisted snapshot that fails the schema is rejected", () => {
    const storage = new FakeStorage();
    writePersistedSnapshot(storage, { boards: "not-an-array" }, 5);
    const { sync } = makeSync(storage);

    const socket = openSocket(sync);

    expect(sync.state.snapshot).toBeNull();
    expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
  });

  test("start is idempotent, which is what makes Strict Mode safe", () => {
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

  test("browser offline closes the socket and online reconnects from the applied cursor", () => {
    const { sync } = makeSync();
    const first = liveSocket(sync);
    first.emit(eventFrame(1, 1));

    sync.networkOffline();

    expect(first.closed).toBe(true);
    expect(sync.state.status).toBe("offline");
    expect(sync.state.lastSeq).toBe(1);

    sync.reconnectNow();
    const second = FakeSocket.last;
    expect(second).not.toBe(first);
    second.open();

    expect(JSON.parse(second.sent[0] as string)).toEqual({
      since: 1,
      type: "hello",
      workspaceId: TEST_WORKSPACE_ID,
    });
  });

  test("only one handshake is in flight at a time", () => {
    const { sync } = makeSync();
    const socket = openSocket(sync);

    expect(sync.handshakeInFlight).toBe(true);

    socket.emit({
      head: 0,
      type: "ready",
      workspaceId: TEST_WORKSPACE_ID,
    });

    expect(sync.handshakeInFlight).toBe(false);
  });

  test("an unexplained close on an implicit URL names the missing env var", () => {
    const scheduler = new FakeScheduler();
    const sync = new ChorusSync({
      cancel: scheduler.cancel,
      createSocket: (url) => new FakeSocket(url),
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
      openSocket(sync);
      FakeSocket.last.remoteClose(1006);
      scheduler.flushOne();
    }
    openSocket(sync);
    FakeSocket.last.emit({
      head: 0,
      type: "ready",
      workspaceId: TEST_WORKSPACE_ID,
    });
    scheduler.pending.length = 0;
    FakeSocket.last.remoteClose(1006);

    expect(scheduler.delays[0]).toBe(250);
  });

  test("a server that accepts then closes does not reset the backoff", () => {
    const { scheduler, sync } = makeSync();
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
    socket.emit({
      head: 0,
      type: "ready",
      workspaceId: TEST_WORKSPACE_ID,
    });
    socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });

    socket.sent.length = 0;
    for (const seq of [6, 8, 10, 12]) {
      socket.emit(eventFrame(seq - 1, seq));
    }

    expect(socket.sentTypes.filter((type) => type === "resync")).toHaveLength(
      1
    );
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
      random: () => 1,
      schedule: scheduler.schedule,
      storage,
      url: "ws://localhost:2000/ws",
    });
    const socket = openSocket(sync);
    socket.emit({
      head: 0,
      type: "ready",
      workspaceId: TEST_WORKSPACE_ID,
    });
    socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });
    socket.emit(eventFrame(1, 1));
    socket.emit(eventFrame(2, 2));
    expect(sync.state.lastSeq).toBe(2);
    expect(readPersistedSnapshot(storage)?.seq).toBe(0);
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
    socket.emit({
      head: 0,
      type: "ready",
      workspaceId: TEST_WORKSPACE_ID,
    });
    socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });

    socket.sent.length = 0;
    socket.emit(eventFrame(1, 1));
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

    socket.emit({
      head: 7,
      type: "ready",
      workspaceId: TEST_WORKSPACE_ID,
    });
    socket.emit({ data: snapshotFixture(), seq: 7, type: "snapshot" });

    expect(sync.state.lastSeq).toBe(7);
    expect(sync.state.status).toBe("live");
    expect(snapshots).toHaveLength(1);
    expect(readPersistedSnapshot(storage)?.seq).toBe(7);
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
    socket.emit(eventFrame(1, 500));

    expect(sync.state.lastSeq).toBe(500);
    expect(events).toHaveLength(1);
  });

  test("a gap triggers a resync rather than a guess", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));
    socket.emit(eventFrame(3, 3));

    expect(socket.sentTypes).toEqual(["hello", "resync"]);
    expect(events).toHaveLength(1);
    expect(sync.state.lastSeq).toBe(1);
    expect(sync.state.lastError).toContain("gap");
  });

  test("a duplicate frame is ignored and never re-applied", () => {
    const { events, sync } = makeSync();
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));
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
    expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
  });

  test("applying an event with hostile storage still advances the cursor", () => {
    const { sync } = makeSync(new HostileStorage());
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));
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

describe("authentication expiry", () => {
  test("close 4401 stops reconnecting and emits AUTH_EXPIRED once", () => {
    const storage = new FakeStorage();
    const { authExpiredCalls, scheduler, sync } = makeSync(storage);
    sync.start();

    storage.setItem(LEGACY_LAST_SEQ_KEY, "99");
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);

    expect(authExpiredCalls()).toBe(1);
    expect(sync.state.status).toBe("auth-expired");
    expect(storage.getItem(LEGACY_LAST_SEQ_KEY)).toBeNull();
    expect(scheduler.pending).toHaveLength(0);
  });

  test("a dropped session never schedules a reconnect", () => {
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
    storage.setItem(LEGACY_LAST_SEQ_KEY, "5");

    sync.reportUnauthorized();

    expect(storage.getItem(LEGACY_LAST_SEQ_KEY)).toBeNull();
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

describe("asynchronous socket credentials", () => {
  test("waits for credentials before opening the socket and avoids duplicate requests", async () => {
    let resolveUrl: ((url: string) => void) | undefined;
    let preparations = 0;
    const sync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () => {
          preparations += 1;
          return new Promise((resolve) => {
            resolveUrl = resolve;
          });
        },
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      {}
    );

    sync.start();
    sync.reconnectNow();
    await flushPromiseQueue();

    expect(preparations).toBe(1);
    expect(FakeSocket.instances).toHaveLength(0);

    resolveUrl?.("wss://serve.example.test/ws?ticket=once");
    await flushPromiseQueue();

    expect(FakeSocket.last.url).toBe("wss://serve.example.test/ws?ticket=once");
  });

  test("a network-offline transition invalidates pending credentials", async () => {
    let resolveUrl: ((url: string) => void) | undefined;
    const sync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () =>
          new Promise((resolve) => {
            resolveUrl = resolve;
          }),
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      {}
    );

    sync.start();
    await flushPromiseQueue();
    sync.networkOffline();
    resolveUrl?.("wss://serve.example.test/ws?ticket=stale");
    await flushPromiseQueue();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(sync.state.status).toBe("offline");
  });

  test("a credential 401 expires auth, while transient failures retry", async () => {
    const scheduler = new FakeScheduler();
    let authExpired = 0;
    const authSync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () =>
          Promise.reject(new SocketAuthenticationExpiredError()),
        schedule: scheduler.schedule,
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      { onAuthExpired: () => (authExpired += 1) }
    );

    authSync.start();
    await flushPromiseQueue();

    expect(authSync.state.status).toBe("auth-expired");
    expect(authExpired).toBe(1);
    expect(scheduler.pending).toHaveLength(0);

    const retryScheduler = new FakeScheduler();
    const retrySync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () =>
          Promise.reject(new Error("ticket service unavailable")),
        schedule: retryScheduler.schedule,
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      {}
    );

    retrySync.start();
    await flushPromiseQueue();

    expect(retrySync.state.status).toBe("offline");
    expect(retrySync.state.lastError).toContain("ticket service unavailable");
    expect(retryScheduler.pending).toHaveLength(1);
  });

  test("stop invalidates a late credential response", async () => {
    let resolveUrl: ((url: string) => void) | undefined;
    const sync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () =>
          new Promise((resolve) => {
            resolveUrl = resolve;
          }),
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      {}
    );

    sync.start();
    await flushPromiseQueue();
    sync.stop();
    resolveUrl?.("wss://serve.example.test/ws?ticket=late");
    await flushPromiseQueue();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(sync.state.status).toBe("offline");
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
    socket.emit({
      head: 1,
      type: "ready",
      workspaceId: TEST_WORKSPACE_ID,
    });

    expect(seen).toContain("connecting");
    expect(seen).toContain("live");
  });
});
