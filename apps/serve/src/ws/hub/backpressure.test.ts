import { describe, expect, test } from "bun:test";
import { HIGH_WATER_MARK, MAX_CONSECUTIVE_DROPS, WorkspaceHub } from "../hub";
import { connect, makeSocket, makeStore } from "./test-support";

describe("backpressure", () => {
  function bufferedEvent(boardId: string, seq: number) {
    return {
      boardId,
      event: {
        boardId,
        delta: "x",
        stepId: `s${seq}`,
        taskId: "t1",
        ts: seq,
        type: "step.delta_appended" as const,
      },
      seq,
    };
  }

  test("above the high-water mark, coalescible patches are skipped", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket(0);
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    socket.buffered = HIGH_WATER_MARK + 1;
    hub.publishRecord(bufferedEvent("board-1", 1));
    hub.flush();

    expect(socket.messages).toHaveLength(0);
    hub.close();
  });

  test("control events still flow to a critical-only client", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket(0);
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    socket.buffered = HIGH_WATER_MARK + 1;
    hub.publishRecord(bufferedEvent("board-1", 1));
    hub.flush();
    expect(socket.messages).toHaveLength(0);

    hub.publishRecord({
      boardId: "board-1",
      event: {
        boardId: "board-1",
        kind: "permission",
        taskId: "t1",
        ts: 2,
        type: "card.waiting_for_approval",
      },
      seq: 2,
    });

    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]?.seq).toBe(2);

    hub.close();
  });

  test("the flag clears only once the buffer is comfortably low", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket(0);
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    socket.buffered = HIGH_WATER_MARK + 1;
    hub.publishRecord(bufferedEvent("board-1", 1));
    hub.flush();
    expect(socket.messages).toHaveLength(0);

    socket.buffered = HIGH_WATER_MARK - 1;
    hub.publishRecord(bufferedEvent("board-1", 2));
    hub.flush();
    expect(socket.messages).toHaveLength(0);

    socket.buffered = HIGH_WATER_MARK / 4;
    hub.publishRecord(bufferedEvent("board-1", 3));
    hub.flush();
    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]?.seq).toBe(3);

    hub.close();
  });

  test("a socket reporting no buffered amount is never throttled", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();

    // biome-ignore lint/performance/noDelete: simulates a transport without the method
    delete (socket as { getBufferedAmount?: () => number }).getBufferedAmount;
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    hub.publishRecord(bufferedEvent("board-1", 1));
    hub.flush();

    expect(socket.messages).toHaveLength(1);
    hub.close();
  });
});

describe("backpressure recovery", () => {
  function coalescible(boardId: string, seq: number) {
    return {
      boardId,
      event: {
        boardId,
        delta: "x",
        stepId: `s${seq}`,
        taskId: "t1",
        ts: seq,
        type: "step.delta_appended" as const,
      },
      seq,
    };
  }

  test("a critical-only client recovers from a drained buffer alone", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket(0);
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    socket.buffered = HIGH_WATER_MARK + 1;
    hub.publishRecord(coalescible("board-1", 1));
    hub.flush();
    expect(socket.messages).toHaveLength(0);
    expect(hub.stats().criticalOnlyClients).toBe(1);

    socket.buffered = 0;
    hub.publishRecord(coalescible("board-1", 2));
    hub.flush();

    expect(socket.messages).toHaveLength(1);
    expect(hub.stats().criticalOnlyClients).toBe(0);

    hub.close();
  });

  test("without a buffer gauge, recovery waits for a positive send", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket(0);
    // biome-ignore lint/performance/noDelete: simulates a transport with no gauge
    delete (socket as { getBufferedAmount?: () => number }).getBufferedAmount;
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    hub.publishRecord(coalescible("board-1", 1));
    hub.flush();

    hub.publishRecord({
      boardId: "board-1",
      event: {
        boardId: "board-1",
        kind: "permission",
        taskId: "t1",
        ts: 2,
        type: "card.waiting_for_approval",
      },
      seq: 2,
    });
    hub.publishRecord(coalescible("board-1", 3));
    hub.flush();

    expect(socket.messages.some((m) => m.seq === 3)).toBe(true);

    hub.close();
  });

  test("send statuses are counted separately for diagnostics", async () => {
    const modes = [
      { expected: "backpressuredFrames", status: -1 },
      { expected: "droppedFrames", status: 0 },
    ] as const;

    for (const mode of modes) {
      const store = makeStore();
      await store.load();
      const hub = new WorkspaceHub(store);
      const socket = makeSocket(0);
      await connect(hub, socket, 0);
      socket.send = () => mode.status;

      hub.publishRecord(coalescible("board-1", 1));
      hub.flush();

      expect(hub.stats()[mode.expected]).toBe(1);

      hub.close();
    }
  });

  test("clients are tracked by connection id, not object identity", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const registered = makeSocket(0);
    await connect(hub, registered, 0);

    const sameConnection = {
      ...registered,
      messages: [] as Record<string, unknown>[],
      sent: [] as string[],
      send: (data: string) => {
        sameConnection.sent.push(data);
        return data.length;
      },
    };

    registered.sent.length = 0;

    await hub.handleRawMessage(
      sameConnection,
      JSON.stringify({ since: 0, type: "hello" })
    );

    expect(registered.sent.length).toBeGreaterThan(0);
    expect(hub.clientCount()).toBe(1);

    hub.close();
  });
});

describe("backpressure behavior", () => {
  test("a peer discarding frames is closed rather than ignored", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.closeCalls.length = 0;
    socket.send = () => 0;

    for (let index = 0; index < MAX_CONSECUTIVE_DROPS; index += 1) {
      hub.publishRecord({
        boardId: "board-1",
        event: {
          boardId: "board-1",
          kind: "permission",
          taskId: "t1",
          ts: index + 1,
          type: "card.waiting_for_approval",
        },
        seq: index + 1,
      });
    }

    expect(socket.closeCalls.at(-1)?.code).toBe(1011);
    expect(hub.clientCount()).toBe(0);

    hub.close();
  });
});
