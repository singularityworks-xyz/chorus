import { describe, expect, test } from "bun:test";
import { WorkspaceHub, WS_CONTROL_LIMIT_PER_MINUTE } from "../hub";
import { connect, makeSocket, makeStore } from "./test-support";

describe("control rate limit", () => {
  test("exceeding the per-minute cap closes the socket with 4429", async () => {
    const store = makeStore();
    await store.load();
    const hub = new WorkspaceHub(store);
    const socket = makeSocket();
    hub.register(socket);

    for (let index = 0; index <= WS_CONTROL_LIMIT_PER_MINUTE; index += 1) {
      await hub.handleRawMessage(
        socket,
        JSON.stringify({ since: 0, type: "hello" })
      );
    }

    expect(socket.closeCalls.at(-1)?.code).toBe(4429);
    expect(hub.clientCount()).toBe(0);
    expect(hub.stats().dropReasons["control-rate-limit"]).toBe(1);

    hub.close();
  });

  test("the budget resets after a minute", async () => {
    const store = makeStore();
    await store.load();
    let clock = 1_000_000;
    const hub = new WorkspaceHub(store, { now: () => clock });
    const socket = makeSocket();
    hub.register(socket);

    for (let index = 0; index < 60; index += 1) {
      await hub.handleRawMessage(
        socket,
        JSON.stringify({ since: 0, type: "hello" })
      );
    }
    expect(socket.closeCalls).toHaveLength(0);

    clock += 61_000;
    await hub.handleRawMessage(
      socket,
      JSON.stringify({ since: 0, type: "hello" })
    );

    expect(socket.closeCalls).toHaveLength(0);
    hub.close();
  });
});

describe("limits behavior", () => {
  test("a burst of viewport frames does not close the socket", async () => {
    const store = makeStore();
    await store.load();
    const clock = 1_000_000;
    const hub = new WorkspaceHub(store, { now: () => clock });
    const socket = makeSocket();
    const peer = makeSocket();
    hub.register(peer);
    await connect(hub, peer, 0);
    await connect(hub, socket, 0);

    for (let index = 0; index < 200; index += 1) {
      await hub.handleRawMessage(
        socket,
        JSON.stringify({
          payload: {
            projectId: "p1",
            viewport: { x: index, y: index, zoom: 1 },
          },
          type: "viewport.sync",
        })
      );
    }

    expect(socket.closeCalls).toHaveLength(0);
    expect(hub.clientCount()).toBe(2);

    hub.close();
  });
});

describe("limits behavior", () => {
  test("pong is never charged against the control budget", async () => {
    const store = makeStore();
    await store.load();
    let clock = 1_000_000;
    const hub = new WorkspaceHub(store, { now: () => clock });
    const socket = makeSocket();
    await connect(hub, socket, 0);

    for (let second = 0; second < 60; second += 1) {
      clock += 1000;
      await hub.handleRawMessage(socket, JSON.stringify({ type: "pong" }));
    }

    expect(socket.closeCalls).toHaveLength(0);
    expect(hub.clientCount()).toBe(1);

    hub.close();
  });
});
