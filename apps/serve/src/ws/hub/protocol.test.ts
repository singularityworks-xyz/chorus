import { describe, expect, test } from "bun:test";
import { WorkspaceHub } from "../hub";
import { connect, makeSocket, makeStore } from "./test-support";

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
  });

  test("non-object JSON messages are rejected without throwing", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    hub.register(socket);

    await hub.handleRawMessage(socket, "null");
    await hub.handleRawMessage(socket, "[]");

    expect(socket.messages).toEqual([
      { message: "missing message type", type: "error" },
      { message: "missing message type", type: "error" },
    ]);
    hub.close();
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
  });

  test("task commands are not accepted on the event socket", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    await connect(hub, socket);
    socket.messages.length = 0;

    await hub.handleRawMessage(
      socket,
      JSON.stringify({ payload: {}, type: "task.queue" })
    );

    expect(socket.messages).toEqual([
      { message: "unsupported message type: task.queue", type: "error" },
    ]);
    hub.close();
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
  });
});

describe("protocol behavior", () => {
  test("a repeated hello is refused rather than replaying again", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    await hub.handleRawMessage(
      socket,
      JSON.stringify({ since: 0, type: "hello" })
    );

    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]?.type).toBe("error");

    hub.close();
  });
});

describe("protocol behavior", () => {
  test("resync before hello is refused", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    hub.register(socket);
    socket.messages.length = 0;

    await hub.handleRawMessage(socket, JSON.stringify({ type: "resync" }));

    expect(socket.messages.map((m) => m.type)).toEqual(["error"]);

    hub.close();
  });
});
