import { beforeEach, describe, expect, test } from "bun:test";
import { ChorusSync } from "./chorus-sync";
import { makeSync, openSocket } from "./test-support";
import { FakeScheduler, FakeSocket, FakeStorage } from "./testing";

beforeEach(() => FakeSocket.reset());

describe("reconnect scheduling", () => {
  test("a drop schedules exactly one retry", () => {
    const { scheduler, sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(1006);

    expect(scheduler.pending).toHaveLength(1);
  });

  test("repeated drops do not pile up retries", () => {
    const { scheduler, sync } = makeSync();
    sync.start();

    FakeSocket.last.remoteClose(1006);
    FakeSocket.last.remoteClose(1006);
    FakeSocket.last.remoteClose(1006);

    expect(scheduler.pending).toHaveLength(1);
  });

  test("stop cancels a pending retry", () => {
    const { scheduler, sync } = makeSync();
    openSocket(sync);

    FakeSocket.last.remoteClose(1006);
    expect(scheduler.pending).toHaveLength(1);

    sync.stop();
    expect(scheduler.pending).toHaveLength(0);
  });

  test("stop closes a live socket", () => {
    const { sync } = makeSync();
    const socket = openSocket(sync);

    sync.stop();

    expect(socket.closed).toBe(true);
  });

  test("stop detaches handlers so closing does not re-enter the retry path", () => {
    const { scheduler, sync } = makeSync();
    sync.start();
    const socket = FakeSocket.last;

    sync.stop();
    expect(socket.onclose).toBeNull();
    expect(scheduler.pending).toHaveLength(0);
  });

  test("stop then start reopens", () => {
    const { sync } = makeSync();
    sync.start();
    sync.stop();
    sync.start();

    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("a socket that cannot be created schedules a retry rather than throwing", () => {
    const scheduler = new FakeScheduler();
    const sync = new ChorusSync(
      {
        cancel: scheduler.cancel,
        createSocket: () => {
          throw new Error("SecurityError: blocked");
        },
        schedule: scheduler.schedule,
        storage: new FakeStorage(),
        url: "ws://localhost:2000/ws",
      },
      {}
    );

    expect(() => sync.start()).not.toThrow();
    expect(scheduler.pending).toHaveLength(1);
    expect(sync.state.lastError).toContain("blocked");
  });

  test("a hello that throws on send does not strand the handshake flag", () => {
    const { sync } = makeSync();
    sync.start();
    const socket = FakeSocket.last;
    socket.send = () => {
      throw new Error("socket closed");
    };

    expect(() => socket.open()).not.toThrow();
    expect(sync.handshakeInFlight).toBe(false);
  });
});
