import { describe, expect, test } from "bun:test";
import { PONG_TIMEOUT_MS, WorkspaceHub } from "../hub";
import { connect, makeSocket, makeStore } from "./test-support";

describe("authenticated device presence", () => {
  test("expired or revoked device state blocks the next outbound frame", async () => {
    const store = makeStore();
    let allowed = true;
    const hub = new WorkspaceHub(store, { isDeviceAllowed: () => allowed });
    const socket = makeSocket();
    hub.register(socket, "d".repeat(32));
    await hub.handleRawMessage(
      socket,
      JSON.stringify({ type: "hello", since: 0 })
    );
    const delivered = socket.sent.length;
    expect(delivered).toBeGreaterThan(0);
    allowed = false;
    await hub.handleRawMessage(socket, JSON.stringify({ type: "resync" }));
    expect(socket.sent).toHaveLength(delivered);
    expect(socket.closeCalls[0]?.code).toBe(4401);
    expect(hub.clientCount()).toBe(0);
    hub.close();
  });
  test("only ready, healthy sockets suppress push and multiple tabs are counted independently", async () => {
    const store = makeStore();
    const hub = new WorkspaceHub(store, { pingIntervalMs: 1000 });
    const firstTab = makeSocket();
    const secondTab = makeSocket();
    const deviceId = "d".repeat(32);

    hub.register(firstTab, deviceId);
    hub.register(secondTab, deviceId);
    expect(hub.hasReadyConnectionForDevice(deviceId)).toBe(false);

    await hub.handleRawMessage(
      firstTab,
      JSON.stringify({ since: 0, type: "hello" })
    );
    expect(hub.hasReadyConnectionForDevice(deviceId)).toBe(true);

    hub.unregister(firstTab);
    expect(hub.hasReadyConnectionForDevice(deviceId)).toBe(false);

    await hub.handleRawMessage(
      secondTab,
      JSON.stringify({ since: 0, type: "hello" })
    );
    expect(hub.hasReadyConnectionForDevice(deviceId)).toBe(true);
    hub.unregister(secondTab);
    expect(hub.hasReadyConnectionForDevice(deviceId)).toBe(false);
    hub.close();
  });

  test("logout closes every mirror for that device immediately", async () => {
    const hub = new WorkspaceHub(makeStore());
    const firstTab = makeSocket();
    const secondTab = makeSocket();
    const otherDevice = makeSocket();
    const deviceId = "e".repeat(32);

    hub.register(firstTab, deviceId);
    hub.register(secondTab, deviceId);
    hub.register(otherDevice, "f".repeat(32));
    await Promise.all([
      hub.handleRawMessage(
        firstTab,
        JSON.stringify({ since: 0, type: "hello" })
      ),
      hub.handleRawMessage(
        secondTab,
        JSON.stringify({ since: 0, type: "hello" })
      ),
      hub.handleRawMessage(
        otherDevice,
        JSON.stringify({ since: 0, type: "hello" })
      ),
    ]);

    expect(hub.disconnectDevice(deviceId)).toBe(2);
    expect(firstTab.closeCalls).toEqual([{ code: 1000, reason: "signed out" }]);
    expect(secondTab.closeCalls).toEqual([
      { code: 1000, reason: "signed out" },
    ]);
    expect(otherDevice.closeCalls).toEqual([]);
    expect(hub.hasReadyConnectionForDevice(deviceId)).toBe(false);
    expect(hub.hasReadyConnectionForDevice("f".repeat(32))).toBe(true);
    hub.close();
  });
});

describe("heartbeat", () => {
  test("the first heartbeat sends a ping before the pong timeout begins", async () => {
    const store = makeStore();
    await store.load();
    let clock = 1000;
    const hub = new WorkspaceHub(store, {
      now: () => clock,
      pingIntervalMs: 30,
      pongTimeoutMs: 10,
    });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    const advanceClock = setTimeout(() => {
      clock += 30;
    }, 15);
    await Bun.sleep(40);
    clearTimeout(advanceClock);

    expect(socket.closeCalls).toHaveLength(0);
    expect(socket.messages.some((message) => message.type === "ping")).toBe(
      true
    );
    expect(hub.clientCount()).toBe(1);
    hub.close();
  });

  test("a client that misses two pongs is closed and fully deregistered", async () => {
    const store = makeStore();
    await store.load();
    let clock = 1_000_000;
    const hub = new WorkspaceHub(store, {
      now: () => clock,
      pingIntervalMs: 1,
    });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    clock += PONG_TIMEOUT_MS * 3;
    await Bun.sleep(25);

    expect(socket.closeCalls.at(-1)?.code).toBe(4000);
    expect(socket.closeCalls.at(-1)?.reason).toBe("pong timeout");
    expect(hub.clientCount()).toBe(0);
    expect(hub.stats().dropReasons["pong-timeout"]).toBe(1);

    const before = socket.sent.length;
    await hub.handleRawMessage(
      socket,
      JSON.stringify({ since: 0, type: "hello" })
    );
    expect(socket.sent.length).toBe(before);

    hub.close();
  });

  test("a pong resets the deadline", async () => {
    const store = makeStore();
    await store.load();
    let clock = 1_000_000;
    const hub = new WorkspaceHub(store, {
      now: () => clock,
      pingIntervalMs: 1,
    });
    const socket = makeSocket();
    await connect(hub, socket, 0);

    for (let round = 0; round < 4; round += 1) {
      clock += PONG_TIMEOUT_MS;
      await hub.handleRawMessage(socket, JSON.stringify({ type: "pong" }));
      await Bun.sleep(6);
      expect(socket.closeCalls).toHaveLength(0);
    }

    expect(hub.clientCount()).toBe(1);
    hub.close();
  });

  test("the heartbeat ping is sequenced accounting, not a bare write", async () => {
    const store = makeStore();
    await store.load();
    let clock = 1_000_000;
    const hub = new WorkspaceHub(store, {
      now: () => clock,
      pingIntervalMs: 1,
    });
    const socket = makeSocket();
    await connect(hub, socket, 0);
    socket.messages.length = 0;

    socket.send = () => -1;
    clock += 1000;
    await Bun.sleep(10);

    expect(hub.stats().backpressuredFrames).toBeGreaterThan(0);

    hub.close();
  });
});
