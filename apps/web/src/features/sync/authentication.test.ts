import { beforeEach, describe, expect, test } from "bun:test";
import { WS_CLOSE_UNAUTHORIZED } from "@chorus/contracts";
import { LEGACY_LAST_SEQ_KEY } from "./snapshot-storage";
import { makeSync } from "./test-support";
import { FakeSocket, FakeStorage } from "./testing";

beforeEach(() => FakeSocket.reset());

describe("authentication expiry", () => {
  test("close 4401 stops reconnecting and emits AUTH_EXPIRED once", () => {
    const storage = new FakeStorage();
    const { authExpiredCalls, scheduler, sync } = makeSync(storage);
    sync.start();

    storage.setItem(LEGACY_LAST_SEQ_KEY, "99");
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);

    expect(authExpiredCalls()).toBe(1);
    expect(sync.state.status).toBe("auth-expired");
    expect(storage.getItem(LEGACY_LAST_SEQ_KEY)).toBeNull();
    expect(scheduler.pending).toHaveLength(0);
  });

  test("a dropped session never schedules a reconnect", () => {
    const { scheduler, sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      scheduler.flushAll();
    }

    expect(FakeSocket.instances).toHaveLength(1);
    expect(scheduler.pending).toHaveLength(0);
  });

  test("AUTH_EXPIRED is emitted exactly once across repeated failures", () => {
    const { authExpiredCalls, sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);
    sync.reportUnauthorized();
    sync.reportUnauthorized();

    expect(authExpiredCalls()).toBe(1);
  });

  test("start and reconnectNow are inert once auth has expired", () => {
    const { sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(WS_CLOSE_UNAUTHORIZED);
    const before = FakeSocket.instances.length;

    sync.start();
    sync.reconnectNow();

    expect(FakeSocket.instances).toHaveLength(before);
  });

  test("an HTTP 401 reported into the sync clears the cursor", () => {
    const storage = new FakeStorage();
    const { sync } = makeSync(storage);
    sync.start();
    storage.setItem(LEGACY_LAST_SEQ_KEY, "5");

    sync.reportUnauthorized();

    expect(storage.getItem(LEGACY_LAST_SEQ_KEY)).toBeNull();
    expect(sync.state.status).toBe("auth-expired");
  });

  test("an ordinary drop is not mistaken for an auth failure", () => {
    const { authExpiredCalls, scheduler, sync } = makeSync();
    sync.start();
    FakeSocket.last.remoteClose(1006);

    expect(sync.state.status).toBe("offline");
    expect(scheduler.pending).toHaveLength(1);
    expect(authExpiredCalls()).toBe(0);
  });
});
