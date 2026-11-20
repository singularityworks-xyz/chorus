import { describe, expect, test } from "bun:test";
import type { WorkspaceEvent } from "@chorus/contracts";
import { MAX_REPLAY_GAP } from "@chorus/contracts";
import { WorkspaceHub } from "../hub";
import { decideResume } from "../hub/resume";
import { connect, makeSocket, makeStore, seedBoard } from "./test-support";

describe("resume handshake", () => {
  test("a fresh client receives ready then a snapshot", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    await connect(hub, socket, 0);

    expect(socket.messages[0]).toEqual({
      head: 0,
      type: "ready",
      workspaceId: store.workspaceId,
    });
    expect(socket.messages[1]?.type).toBe("snapshot");
    expect(hub.clientCount()).toBe(1);

    hub.close();
  });

  test("a caught-up client receives ready and no snapshot", async () => {
    const store = makeStore();
    await store.load();
    await seedBoard(store);
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    await connect(hub, socket, store.headSeq());

    expect(socket.messages[0]).toEqual({
      head: 1,
      type: "ready",
      workspaceId: store.workspaceId,
    });
    expect(socket.messages).toHaveLength(1);

    hub.close();
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

    await connect(hub, socket, 1);

    expect(socket.messages[0]?.type).toBe("ready");
    const events = socket.messages.filter((m) => m.type === "event");
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(2);
    expect((events[0]?.event as WorkspaceEvent).type === "board.moved").toBe(
      true
    );

    hub.close();
  });

  test("a gap larger than the threshold falls back to a snapshot", async () => {
    const store = makeStore();
    await store.load();
    const boardId = await seedBoard(store);

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
  });

  test("a client ahead of the server gets a snapshot rather than silence", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();

    await connect(hub, socket, 9999);

    expect(socket.messages[1]?.type).toBe("snapshot");

    hub.close();
  });

  test("a different workspace with the same sequence gets a fresh snapshot", async () => {
    const previous = makeStore();
    await previous.load();
    const previousBoardId = await seedBoard(previous, "Previous workspace");

    const current = makeStore();
    await current.load();
    const currentBoardId = await seedBoard(current, "Current workspace");
    expect(current.headSeq()).toBe(previous.headSeq());
    expect(current.workspaceId).not.toBe(previous.workspaceId);

    const hub = new WorkspaceHub(current);
    const socket = makeSocket();
    hub.register(socket);
    await hub.handleRawMessage(
      socket,
      JSON.stringify({
        since: previous.headSeq(),
        type: "hello",
        workspaceId: previous.workspaceId,
      })
    );

    expect(socket.messages[1]?.type).toBe("snapshot");
    const snapshot = socket.messages[1]?.data as {
      boards: { boardId: string }[];
    };
    expect(snapshot.boards.map((board) => board.boardId)).toEqual([
      currentBoardId,
    ]);
    expect(snapshot.boards.map((board) => board.boardId)).not.toContain(
      previousBoardId
    );

    hub.close();
  });

  test("a client resuming from before the snapshot floor gets a snapshot", async () => {
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

    await store.writeSnapshot();

    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    await connect(hub, socket, 1);

    expect(store.replayFloorSeq()).toBe(2);
    expect(socket.messages[0]?.type).toBe("ready");
    expect(socket.messages[1]?.type).toBe("snapshot");

    hub.close();
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
  });
});

describe("decideResume", () => {
  test("nothing missing means nothing to send", () => {
    expect(decideResume(10, 10, 0)).toEqual({ kind: "up-to-date" });
  });

  test("a changed workspace always replaces the cached state", () => {
    expect(decideResume(10, 10, 0, false)).toEqual({
      kind: "snapshot",
      reason: "workspace-changed",
    });
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
