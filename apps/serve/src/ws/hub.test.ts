import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceEvent } from "@chorus/contracts";
import { MAX_REPLAY_GAP } from "@chorus/contracts";
import { WorkspaceStore } from "../workspace/store";
import { decideResume, type HubSocket, WorkspaceHub } from "./hub";

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
