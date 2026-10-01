import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceEvent } from "@chorus/contracts";
import { MAX_REPLAY_GAP } from "@chorus/contracts";
import { WorkspaceStore } from "../workspace/store";
import {
  decideResume,
  HIGH_WATER_MARK,
  type HubSocket,
  WorkspaceHub,
} from "./hub";

const dirs: string[] = [];

function makeStore(): WorkspaceStore {
  const dir = mkdtempSync(join(tmpdir(), "chorus-hub-"));
  dirs.push(dir);
  return new WorkspaceStore(dir);
}

function cleanup() {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
}

let socketCounter = 0;

interface FakeSocket extends HubSocket {
  buffered: number;
  close?: (code?: number, reason?: string) => void;
  closeCalls: { code?: number; reason?: string }[];
  getBufferedAmount: () => number;
  messages: Record<string, unknown>[];
  send: (data: string) => unknown;
  sent: string[];
}

function makeSocket(buffered = 0): FakeSocket {
  const socket = {
    buffered,
    closeCalls: [] as { code?: number; reason?: string }[],
    id: `sock-${socketCounter++}`,
    getBufferedAmount: () => socket.buffered,
    messages: [] as Record<string, unknown>[],
    sent: [] as string[],
    send(data: string) {
      socket.sent.push(data);
      socket.messages.push(JSON.parse(data) as Record<string, unknown>);
      // Matches Bun's ServerWebSocket: send() reports bytes accepted.
      return data.length;
    },
  } as FakeSocket;

  socket.close = (code?: number, reason?: string) => {
    socket.closeCalls.push({ code, reason });
  };
  return socket;
}

async function connect(hub: WorkspaceHub, socket: FakeSocket, since = 0) {
  hub.register(socket);
  await hub.handleRawMessage(socket, JSON.stringify({ since, type: "hello" }));
}

/** Seeds a board and returns its id. */
async function seedBoard(store: WorkspaceStore): Promise<string> {
  const commit = await store.applyMutation({
    baseRevision: null,
    clientId: "hub-test",
    mutationId: `seed-${crypto.randomUUID()}`,
    payload: {
      seed: {
        repo: { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" },
        title: "Repo",
      },
    },
    type: "board.create",
  });
  const event = commit?.events[0];
  if (!commit || event?.type !== "board.created") {
    throw new Error("expected board.created");
  }
  return event.board.boardId;
}

describe("resume handshake", () => {
  test("a fresh client receives ready then a snapshot", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    await connect(hub, socket, 0);

    expect(socket.messages[0]).toEqual({ head: 0, type: "ready" });
    expect(socket.messages[1]?.type).toBe("snapshot");
    expect(hub.clientCount()).toBe(1);

    hub.close();
    cleanup();
  });

  test("a caught-up client receives ready and no snapshot", async () => {
    const store = makeStore();
    await store.load();
    await seedBoard(store);
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    await connect(hub, socket, store.headSeq());

    expect(socket.messages[0]).toEqual({ head: 1, type: "ready" });
    expect(socket.messages).toHaveLength(1);

    hub.close();
    cleanup();
  });

  test("a small gap replays exactly the missing events in order", async () => {
    const store = makeStore();
    await store.load();
    const boardId = await seedBoard(store);
    await store.applyMutation({
      baseRevision: null,
      clientId: "hub-test",
      mutationId: "move-1",
      payload: { boardId, position: { x: 5, y: 6 } },
      type: "board.move",
    });

    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    // Client has only seen seq 1.
    await connect(hub, socket, 1);

    expect(socket.messages[0]?.type).toBe("ready");
    const events = socket.messages.filter((m) => m.type === "event");
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(2);
    expect((events[0]?.event as WorkspaceEvent).type === "board.moved").toBe(
      true
    );

    hub.close();
    cleanup();
  });

  test("a gap larger than the threshold falls back to a snapshot", async () => {
    const store = makeStore();
    await store.load();
    const boardId = await seedBoard(store);

    // Fill past MAX_REPLAY_GAP.
    for (let index = 0; index < MAX_REPLAY_GAP + 5; index += 1) {
      await store.applyMutation({
        baseRevision: null,
        clientId: "hub-test",
        mutationId: `fill-${index}`,
        payload: { boardId, position: { x: index, y: index } },
        type: "board.move",
      });
    }

    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    await connect(hub, socket, 1);

    expect(socket.messages[0]?.type).toBe("ready");
    expect(socket.messages[1]?.type).toBe("snapshot");
    expect(socket.messages.some((m) => m.type === "event")).toBe(false);

    hub.close();
    cleanup();
  });

  test("a client ahead of the server gets a snapshot rather than silence", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    await connect(hub, socket, 9999);

    expect(socket.messages[1]?.type).toBe("snapshot");

    hub.close();
    cleanup();
  });

  test("a client resuming from before the snapshot floor gets a snapshot", async () => {
    // Events are pruned into snapshots. A client resuming from below the floor
    // has a small gap that cannot actually be replayed — serving it the few rows
    // that remain would silently diverge.
    const store = makeStore();
    await store.load();
    const boardId = await seedBoard(store);
    await store.applyMutation({
      baseRevision: null,
      clientId: "hub-test",
      mutationId: "move-1",
      payload: { boardId, position: { x: 9, y: 9 } },
      type: "board.move",
    });
    // Snapshot at head, which prunes everything below it.
    await store.writeSnapshot();

    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    await connect(hub, socket, 1);

    expect(store.replayFloorSeq()).toBe(2);
    expect(socket.messages[0]?.type).toBe("ready");
    expect(socket.messages[1]?.type).toBe("snapshot");

    hub.close();
    cleanup();
  });

  test("resync sends a snapshot on demand", async () => {
    const store = makeStore();
    await store.load();
    await seedBoard(store);
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    await connect(hub, socket, store.headSeq());
    socket.messages.length = 0;

    await hub.handleRawMessage(socket, JSON.stringify({ type: "resync" }));

    expect(socket.messages[0]?.type).toBe("snapshot");

    hub.close();
    cleanup();
  });

  test("nothing is pushed before hello completes", async () => {
    const store = makeStore();
    await store.load();
    await seedBoard(store);
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    hub.register(socket);
    expect(socket.messages).toHaveLength(0);

    hub.publish({
      boardId: "board-1",
      events: [
        {
          boardId: "board-1",
          taskId: "t1",
          ts: 1,
          type: "card.started",
        },
      ],
      firstSeq: 2,
      lastSeq: 2,
    });

    expect(socket.messages).toHaveLength(0);

    hub.close();
    cleanup();
  });
});

describe("decideResume", () => {
  test("nothing missing means nothing to send", () => {
    expect(decideResume(10, 10, 0)).toEqual({ kind: "up-to-date" });
  });

  test("a small gap replays from the client's position", () => {
    expect(decideResume(10, 12, 0)).toEqual({
      fromSeq: 10,
      kind: "replay",
    });
  });

  test("a gap at the threshold still replays", () => {
    expect(decideResume(0, MAX_REPLAY_GAP, 0).kind).toBe("replay");
  });

  test("one past the threshold falls back to a snapshot", () => {
    expect(decideResume(0, MAX_REPLAY_GAP + 1, 0)).toEqual({
      kind: "snapshot",
      reason: "gap-too-large",
    });
  });

  test("a position below the replay floor cannot be served", () => {
    // Small gap, but the rows are gone.
    expect(decideResume(3, 8, 7)).toEqual({
      kind: "snapshot",
      reason: "pruned",
    });
  });

  test("a client ahead of the server gets a snapshot", () => {
    expect(decideResume(11, 10, 0)).toEqual({
      kind: "snapshot",
      reason: "client-ahead",
    });
  });
});

describe("malformed input", () => {
  test("invalid json yields an error, not a throw", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    hub.register(socket);

    await hub.handleRawMessage(socket, "{not json");

    expect(socket.messages[0]).toEqual({
      message: "malformed json",
      type: "error",
    });
    hub.close();
    cleanup();
  });

  test("a message with no type is rejected", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    hub.register(socket);

    await hub.handleRawMessage(socket, JSON.stringify({ nope: true }));

    expect(socket.messages[0]).toEqual({
      message: "missing message type",
      type: "error",
    });
    hub.close();
    cleanup();
  });

  test("a hello with a bad `since` is rejected", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    hub.register(socket);

    await hub.handleRawMessage(
      socket,
      JSON.stringify({ since: -5, type: "hello" })
    );

    expect(socket.messages[0]).toEqual({
      message: "invalid hello",
      type: "error",
    });
    hub.close();
    cleanup();
  });

  test("messages from an unregistered socket are ignored", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    await hub.handleRawMessage(
      socket,
      JSON.stringify({ since: 0, type: "hello" })
    );

    expect(socket.messages).toHaveLength(0);
    hub.close();
    cleanup();
  });
});

describe("command rate limit", () => {
  test("exceeding the per-minute cap closes the socket with 4429", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    hub.register(socket);

    for (let index = 0; index < 61; index += 1) {
      await hub.handleRawMessage(socket, JSON.stringify({ type: "pong" }));
    }

    expect(socket.closeCalls.at(-1)?.code).toBe(4429);
    expect(hub.clientCount()).toBe(0);

    hub.close();
    cleanup();
  });

  test("the budget resets after a minute", async () => {
    const store = makeStore();
    await store.load();
    let clock = 1_000_000;
    const hub = new WorkspaceHub(store, { now: () => clock });
    const socket = makeSocket();
    hub.register(socket);

    for (let index = 0; index < 60; index += 1) {
      await hub.handleRawMessage(socket, JSON.stringify({ type: "pong" }));
    }
    expect(socket.closeCalls).toHaveLength(0);

    clock += 61_000;
    await hub.handleRawMessage(socket, JSON.stringify({ type: "pong" }));

    expect(socket.closeCalls).toHaveLength(0);
    hub.close();
    cleanup();
  });
});

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

    // Nothing yet: the window is 10s. Fifty *distinct* steps, so nothing merges.
    expect(socket.messages).toHaveLength(0);
    expect(hub.stats().coalescerDepth).toBe(50);

    hub.flush();
    expect(socket.messages).toHaveLength(50);

    hub.close();
    cleanup();
  });

  test("an approval request is not buffered", async () => {
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

    // The approval arrived immediately, ahead of the buffered deltas.
    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]?.seq).toBe(21);
    expect((socket.messages[0]?.event as { type: string }).type).toBe(
      "card.waiting_for_approval"
    );

    hub.close();
    cleanup();
  });

  test("a burst of deltas flushes as far fewer messages than it had events", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 100 });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    // A streaming response part: hundreds of token deltas for ONE stepId.
    for (let index = 1; index <= 500; index += 1) {
      hub.publishRecord(stepEvent("board-1", index, "part-abc"));
    }

    await Bun.sleep(250);

    // They merge by step, so 500 deltas collapse to a single frame.
    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]?.seq).toBe(1);
    expect(hub.stats().coalescerDepth).toBe(0);

    // ...and the merge is lossless: every token is still there, in order.
    const merged = socket.messages[0]?.event as { delta: string };
    expect(merged.delta).toBe("x".repeat(500));

    hub.close();
    cleanup();
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
    cleanup();
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

    // part-a's two deltas merged; part-b's one stayed separate.
    expect(socket.messages).toHaveLength(2);
    const seqs = socket.messages
      .map((m) => m.seq as number)
      .sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2]);
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
    hub.flush();

    // Same stepId on another board must not absorb the first board's delta.
    expect(socket.messages).toHaveLength(2);
  });

  test("flush is a no-op when nothing is buffered", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    hub.flush();
    expect(hub.stats().coalescerDepth).toBe(0);
    hub.close();
    cleanup();
  });
});

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

    // Socket has stalled: its buffer is already past the mark.
    socket.buffered = HIGH_WATER_MARK + 1;
    hub.publishRecord(bufferedEvent("board-1", 1));
    hub.flush();

    expect(socket.messages).toHaveLength(0);
    hub.close();
    cleanup();
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

    // An approval must reach the operator regardless of radio conditions.
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
    cleanup();
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

    // Just under the mark but above half of it: hysteresis keeps it flagged.
    socket.buffered = HIGH_WATER_MARK - 1;
    hub.publishRecord(bufferedEvent("board-1", 2));
    hub.flush();
    expect(socket.messages).toHaveLength(0);

    // Below half: the client recovers.
    socket.buffered = HIGH_WATER_MARK / 4;
    hub.publishRecord(bufferedEvent("board-1", 3));
    hub.flush();
    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]?.seq).toBe(3);

    hub.close();
    cleanup();
  });

  test("a socket reporting no buffered amount is never throttled", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    const socket = makeSocket();
    // A socket that cannot report its buffered amount must never be throttled.
    // biome-ignore lint/performance/noDelete: simulates a transport without the method
    delete (socket as { getBufferedAmount?: () => number }).getBufferedAmount;
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    hub.publishRecord(bufferedEvent("board-1", 1));
    hub.flush();

    expect(socket.messages).toHaveLength(1);
    hub.close();
    cleanup();
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
    // Regression: recovery once required N consecutive positive sends, but a
    // critical-only client is sent nothing coalescible, so it could never
    // accumulate them and stayed throttled forever.
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

    // Socket drains; no control traffic ever arrives for this client.
    socket.buffered = 0;
    hub.publishRecord(coalescible("board-1", 2));
    hub.flush();

    expect(socket.messages).toHaveLength(1);
    expect(hub.stats().criticalOnlyClients).toBe(0);

    hub.close();
    cleanup();
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

    // The gauge reads as absent, so congestion comes from send status alone.
    hub.publishRecord(coalescible("board-1", 1));
    hub.flush();

    // A control event still flows to a critical-only client, which is the
    // positive send that lets recovery happen.
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
    cleanup();
  });

  test("send statuses are counted separately for diagnostics", async () => {
    // Each mode gets a fresh client: a client that has already registered
    // backpressure goes critical-only, after which coalescible events are
    // skipped and no further status is ever reported.
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

    cleanup();
  });

  test("clients are tracked by connection id, not object identity", async () => {
    // Elysia hands `open` and `message` different wrapper objects for the same
    // connection. Keying by object identity silently missed every lookup.
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const registered = makeSocket(0);
    await connect(hub, registered, 0);

    // A different object, same connection id — exactly what Elysia produces.
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

    // The lookup resolved to the *registered* client by id, so its socket
    // received the handshake rather than the frames being dropped on the floor.
    expect(registered.sent.length).toBeGreaterThan(0);
    expect(hub.clientCount()).toBe(1);

    hub.close();
    cleanup();
  });
});
