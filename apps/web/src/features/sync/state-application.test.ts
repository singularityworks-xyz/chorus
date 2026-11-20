import { beforeEach, describe, expect, test } from "bun:test";
import { readPersistedSnapshot } from "./snapshot-storage";
import {
  liveSocket,
  makeSync,
  openSocket,
  TEST_WORKSPACE_ID,
} from "./test-support";
import {
  approvalEvent,
  eventFrame,
  FakeSocket,
  FakeStorage,
  snapshotFixture,
} from "./testing";

beforeEach(() => FakeSocket.reset());

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
