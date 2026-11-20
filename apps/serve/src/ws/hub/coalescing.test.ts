import { describe, expect, test } from "bun:test";
import { HIGH_WATER_MARK, WorkspaceHub } from "../hub";
import {
  connect,
  emitDelta,
  makeSocket,
  makeStore,
  seedSession,
} from "./test-support";

describe("coalescing", () => {
  function stepEvent(boardId: string, seq: number, stepId: string) {
    return {
      boardId,
      event: {
        boardId,
        delta: "x",
        kind: "step.delta_appended" as const,
        stepId,
        taskId: "t1",
        ts: seq,
        type: "step.delta_appended" as const,
      },
      seq,
    };
  }

  function approvalEvent(boardId: string, seq: number) {
    return {
      boardId,
      event: {
        boardId,
        kind: "permission" as const,
        taskId: "t1",
        ts: seq,
        type: "card.waiting_for_approval" as const,
      },
      seq,
    };
  }

  test("step deltas are buffered rather than sent immediately", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    for (let index = 1; index <= 50; index += 1) {
      hub.publishRecord(stepEvent("board-1", index, `s${index}`));
    }

    expect(socket.messages).toHaveLength(0);
    expect(hub.stats().coalescerDepth).toBe(50);

    hub.flush();
    expect(socket.messages).toHaveLength(50);

    hub.close();
  });

  test("an approval request waits for the buffer so sequences stay ordered", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    for (let index = 1; index <= 20; index += 1) {
      hub.publishRecord(stepEvent("board-1", index, `s${index}`));
    }
    hub.publishRecord(approvalEvent("board-1", 21));

    expect(socket.messages).toHaveLength(21);
    expect((socket.messages.at(-1)?.event as { type: string }).type).toBe(
      "card.waiting_for_approval"
    );
    expect(
      socket.messages.map((message) => message.seq as number)
    ).toStrictEqual(Array.from({ length: 21 }, (_, index) => index + 1));

    hub.close();
  });

  test("a burst of deltas flushes as far fewer messages than it had events", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 100 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    for (let index = 1; index <= 500; index += 1) {
      hub.publishRecord(stepEvent("board-1", index, "part-abc"));
    }

    await Bun.sleep(250);

    expect(socket.messages).toHaveLength(1);

    expect(socket.messages[0]?.fromSeq).toBe(1);
    expect(socket.messages[0]?.seq).toBe(500);
    expect(hub.stats().coalescerDepth).toBe(0);

    const merged = socket.messages[0]?.event as { delta: string };
    expect(merged.delta).toBe("x".repeat(500));

    hub.close();
  });

  test("coalesced events keep their sequence numbers and stay ordered", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    for (let index = 1; index <= 100; index += 1) {
      hub.publishRecord(stepEvent("board-1", index, `s${index}`));
    }
    hub.flush();

    const seqs = socket.messages.map((m) => m.seq as number);
    expect(seqs).toEqual(seqs.slice().sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(100);

    hub.close();
  });

  test("deltas for different steps do not merge", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    hub.publishRecord(stepEvent("board-1", 1, "part-a"));
    hub.publishRecord(stepEvent("board-1", 2, "part-b"));
    hub.publishRecord(stepEvent("board-1", 3, "part-a"));

    hub.flush();

    expect(socket.messages).toHaveLength(3);
    expect(socket.messages.map((m) => m.seq as number)).toEqual([1, 2, 3]);
  });

  test("different boards keep separate buffers", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    hub.publishRecord(stepEvent("board-1", 1, "part-a"));
    hub.publishRecord(stepEvent("board-2", 2, "part-a"));
    hub.publishRecord(stepEvent("board-1", 3, "part-b"));
    hub.flush();

    expect(socket.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
  });

  test("flush is a no-op when nothing is buffered", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    hub.flush();
    expect(hub.stats().coalescerDepth).toBe(0);
    hub.close();
  });
});

describe("sequence accounting across coalescing", () => {
  test("resume after a coalesced flush does not replay merged deltas", async () => {
    const store = makeStore();
    await store.load();

    await seedSession(store);

    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });

    store.onCommit((commit) => hub.publish(commit));

    const a = makeSocket(0);
    hub.register(a);
    await hub.handleRawMessage(
      a,
      JSON.stringify({ since: 0, type: "hello", workspaceId: hub.workspaceId })
    );
    a.messages.length = 0;

    hub.flush();
    a.messages.length = 0;

    for (const content of ["d1", "d2", "d3"]) {
      await emitDelta(store, content);
    }
    hub.flush();

    const merged = a.messages.filter((m) => m.type === "event");
    expect(merged.length).toBeGreaterThan(0);
    const last = merged.at(-1) as { event: { delta?: string }; seq: number };
    const consumed = merged
      .map((m) => (m.event as { delta?: string }).delta ?? "")
      .join("");

    expect(consumed.length).toBeGreaterThan(0);

    const b = makeSocket(0);
    hub.register(b);
    await hub.handleRawMessage(
      b,
      JSON.stringify({
        since: last.seq,
        type: "hello",
        workspaceId: hub.workspaceId,
      })
    );

    const replayed = b.messages
      .filter((m) => m.type === "event")
      .map((m) => (m.event as { delta?: string }).delta ?? "")
      .join("");

    expect(replayed).toBe("");

    hub.close();
  });

  test("a reconnect inside the coalescing window does not double-deliver", async () => {
    const store = makeStore();
    await store.load();
    await seedSession(store);

    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    store.onCommit((commit) => hub.publish(commit));

    const headBefore = store.headSeq();
    await emitDelta(store, "d11");

    const b = makeSocket(0);
    hub.register(b);
    await hub.handleRawMessage(
      b,
      JSON.stringify({
        since: headBefore,
        type: "hello",
        workspaceId: hub.workspaceId,
      })
    );
    const fromReplay = b.messages.filter((m) => m.type === "event");
    expect(fromReplay.length).toBeGreaterThan(0);

    hub.flush();

    const all = b.messages.filter((m) => m.type === "event");
    expect(all).toHaveLength(fromReplay.length);

    hub.close();
  });

  test("a control event does not overtake a buffered delta", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const a = makeSocket(0);
    hub.register(a);
    await hub.handleRawMessage(a, JSON.stringify({ since: 0, type: "hello" }));
    a.messages.length = 0;

    hub.publishRecord({
      boardId: "board-1",
      event: {
        boardId: "board-1",
        delta: "d7",
        stepId: "s1",
        taskId: "t1",
        ts: 7,
        type: "step.delta_appended",
      },
      seq: 7,
    });
    hub.publishRecord({
      boardId: "board-1",
      event: {
        boardId: "board-1",
        kind: "permission",
        taskId: "t1",
        ts: 8,
        type: "card.waiting_for_approval",
      },
      seq: 8,
    });

    const seqs = a.messages
      .filter((m) => m.type === "event")
      .map((m) => m.seq as number);
    expect(seqs).toEqual([7, 8]);

    hub.close();
  });
});

describe("coalescing correctness", () => {
  test("contiguous deltas for one step merge into a single range", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    for (const seq of [10, 11, 12, 13]) {
      hub.publishRecord({
        boardId: "board-1",
        event: {
          boardId: "board-1",
          delta: `${seq} `,
          stepId: "part-1",
          taskId: "t1",
          ts: seq,
          type: "step.delta_appended",
        },
        seq,
      });
    }
    hub.flush();

    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]?.fromSeq).toBe(10);
    expect(socket.messages[0]?.seq).toBe(13);
    expect((socket.messages[0]?.event as { delta: string }).delta).toBe(
      "10 11 12 13 "
    );

    hub.close();
  });

  test("a skipped coalescible event is not stepped over by a later control event", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket(0);
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    socket.buffered = HIGH_WATER_MARK + 1;

    hub.publishRecord({
      boardId: "board-1",
      event: {
        boardId: "board-1",
        delta: "d1",
        stepId: "s1",
        taskId: "t1",
        ts: 1,
        type: "step.delta_appended",
      },
      seq: 1,
    });
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

    const delivered = socket.messages.filter((m) => m.type === "event");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.fromSeq).toBe(2);

    expect(delivered[0]?.fromSeq).toBeGreaterThan(1);

    hub.close();
  });
});

describe("coalescing behavior", () => {
  test("close flushes the coalescing window instead of discarding it", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    hub.publishRecord({
      boardId: "board-1",
      event: {
        boardId: "board-1",
        delta: "pending",
        stepId: "s1",
        taskId: "t1",
        ts: 1,
        type: "step.delta_appended",
      },
      seq: 1,
    });

    hub.close();

    expect(socket.messages).toHaveLength(1);
    expect((socket.messages[0]?.event as { delta: string }).delta).toBe(
      "pending"
    );
  });
});
