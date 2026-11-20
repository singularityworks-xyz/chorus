import { beforeEach, describe, expect, test } from "bun:test";
import { ChorusSync } from "./chorus-sync";
import { SocketAuthenticationExpiredError } from "./socket-credentials";
import { flushPromiseQueue } from "./test-support";
import { FakeScheduler, FakeSocket, FakeStorage } from "./testing";

beforeEach(() => FakeSocket.reset());

describe("asynchronous socket credentials", () => {
  test("waits for credentials before opening the socket and avoids duplicate requests", async () => {
    let resolveUrl: ((url: string) => void) | undefined;
    let preparations = 0;
    const sync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () => {
          preparations += 1;
          return new Promise((resolve) => {
            resolveUrl = resolve;
          });
        },
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      {}
    );

    sync.start();
    sync.reconnectNow();
    await flushPromiseQueue();

    expect(preparations).toBe(1);
    expect(FakeSocket.instances).toHaveLength(0);

    resolveUrl?.("wss://serve.example.test/ws?ticket=once");
    await flushPromiseQueue();

    expect(FakeSocket.last.url).toBe("wss://serve.example.test/ws?ticket=once");
  });

  test("a network-offline transition invalidates pending credentials", async () => {
    let resolveUrl: ((url: string) => void) | undefined;
    const sync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () =>
          new Promise((resolve) => {
            resolveUrl = resolve;
          }),
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      {}
    );

    sync.start();
    await flushPromiseQueue();
    sync.networkOffline();
    resolveUrl?.("wss://serve.example.test/ws?ticket=stale");
    await flushPromiseQueue();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(sync.state.status).toBe("offline");
  });

  test("a credential 401 expires auth, while transient failures retry", async () => {
    const scheduler = new FakeScheduler();
    let authExpired = 0;
    const authSync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () =>
          Promise.reject(new SocketAuthenticationExpiredError()),
        schedule: scheduler.schedule,
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      { onAuthExpired: () => (authExpired += 1) }
    );

    authSync.start();
    await flushPromiseQueue();

    expect(authSync.state.status).toBe("auth-expired");
    expect(authExpired).toBe(1);
    expect(scheduler.pending).toHaveLength(0);

    const retryScheduler = new FakeScheduler();
    const retrySync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () =>
          Promise.reject(new Error("ticket service unavailable")),
        schedule: retryScheduler.schedule,
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      {}
    );

    retrySync.start();
    await flushPromiseQueue();

    expect(retrySync.state.status).toBe("offline");
    expect(retrySync.state.lastError).toContain("ticket service unavailable");
    expect(retryScheduler.pending).toHaveLength(1);
  });

  test("stop invalidates a late credential response", async () => {
    let resolveUrl: ((url: string) => void) | undefined;
    const sync = new ChorusSync(
      {
        createSocket: (url) => new FakeSocket(url),
        prepareSocketUrl: () =>
          new Promise((resolve) => {
            resolveUrl = resolve;
          }),
        storage: new FakeStorage(),
        url: "wss://serve.example.test/ws",
      },
      {}
    );

    sync.start();
    await flushPromiseQueue();
    sync.stop();
    resolveUrl?.("wss://serve.example.test/ws?ticket=late");
    await flushPromiseQueue();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(sync.state.status).toBe("offline");
  });
});
