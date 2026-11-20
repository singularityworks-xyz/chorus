import { describe, expect, test } from "bun:test";
import { WorkspaceHub } from "../hub";
import { makeSocket, makeStore, seedBoard } from "./test-support";

describe("client capability compatibility", () => {
  test("legacy clients receive a fresh snapshot for card.reordered", async () => {
    const store = makeStore();
    await store.load();
    const boardId = await seedBoard(store);
    const task = (id: string) => ({
      id,
      label: "repo",
      labelVariant: "primary-light" as const,
      title: id,
    });
    await store.applyBoardEvents(boardId, [
      {
        type: "card.created",
        ts: Date.now(),
        boardId,
        column: "queue",
        taskId: "task-a",
        task: task("task-a"),
      },
      {
        type: "card.created",
        ts: Date.now(),
        boardId,
        column: "queue",
        taskId: "task-b",
        task: task("task-b"),
      },
    ]);

    const hub = new WorkspaceHub(store, { coalesceMs: 10_000 });
    store.onCommit((commit) => hub.publish(commit));
    const legacySocket = makeSocket();
    const currentSocket = makeSocket();
    hub.register(legacySocket);
    hub.register(currentSocket);
    const hello = {
      since: store.headSeq(),
      type: "hello",
      workspaceId: store.workspaceId,
    };
    await hub.handleRawMessage(legacySocket, JSON.stringify(hello));
    await hub.handleRawMessage(
      currentSocket,
      JSON.stringify({ ...hello, capabilities: ["card.reordered"] })
    );
    legacySocket.messages.length = 0;
    currentSocket.messages.length = 0;

    await store.applyMutation({
      baseRevision: null,
      clientId: "reorder-test",
      mutationId: "reorder-task-a",
      payload: {
        beforeTaskId: null,
        boardId,
        column: "queue",
        taskId: "task-a",
      },
      type: "board.task.reorder",
    });
    hub.flush();

    expect(legacySocket.messages.map((message) => message.type)).toEqual([
      "snapshot",
    ]);
    expect(legacySocket.messages[0]).toMatchObject({
      seq: store.headSeq(),
      data: {
        boards: [
          {
            boardId,
            columns: { queue: [{ id: "task-b" }, { id: "task-a" }] },
          },
        ],
      },
    });
    expect(currentSocket.messages.map((message) => message.type)).toEqual([
      "event",
    ]);
    expect(currentSocket.messages[0]).toMatchObject({
      event: { type: "card.reordered", taskId: "task-a" },
    });

    hub.close();
  });
});
