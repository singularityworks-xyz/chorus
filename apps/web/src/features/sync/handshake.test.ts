import { beforeEach, describe, expect, test } from "bun:test";
import { ChorusSync } from "./chorus-sync";
import {
  LEGACY_LAST_SEQ_KEY,
  readPersistedSnapshot,
  SNAPSHOT_KEY,
  writePersistedSnapshot,
} from "./snapshot-storage";
import {
  liveSocket,
  makeSync,
  openSocket,
  REPLACEMENT_WORKSPACE_ID,
  TEST_WORKSPACE_ID,
} from "./test-support";
import {
  eventFrame,
  FakeScheduler,
  FakeSocket,
  FakeStorage,
  snapshotFixture,
} from "./testing";

beforeEach(() => FakeSocket.reset());

describe("handshake and resume", () => {
  test("start connects and sends hello with since 0 when there is no history", () => {
    const { sync } = makeSync();
    const socket = openSocket(sync);

    expect(socket.sentTypes).toEqual(["hello"]);
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      capabilities: ["card.reordered"],
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
      capabilities: ["card.reordered"],
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
      capabilities: ["card.reordered"],
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
      capabilities: ["card.reordered"],
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
