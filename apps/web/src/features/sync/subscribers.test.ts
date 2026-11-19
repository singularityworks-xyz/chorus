import { beforeEach, describe, expect, test } from "bun:test";
import { makeSync, openSocket, TEST_WORKSPACE_ID } from "./test-support";
import { FakeSocket } from "./testing";

beforeEach(() => FakeSocket.reset());

describe("subscribers", () => {
  test("a subscriber receives the current state immediately", () => {
    const { sync } = makeSync();
    const seen: string[] = [];

    sync.subscribe((state) => seen.push(state.status));

    expect(seen).toEqual(["offline"]);
  });

  test("unsubscribe stops delivery", () => {
    const { sync } = makeSync();
    const seen: string[] = [];
    const unsubscribe = sync.subscribe((state) => seen.push(state.status));

    sync.start();
    const countBefore = seen.length;
    unsubscribe();
    FakeSocket.last.remoteClose(1006);

    expect(seen).toHaveLength(countBefore);
  });

  test("status transitions are observable", () => {
    const { sync } = makeSync();
    const seen: string[] = [];
    sync.subscribe((state) => seen.push(state.status));

    const socket = openSocket(sync);
    socket.emit({
      head: 1,
      type: "ready",
      workspaceId: TEST_WORKSPACE_ID,
    });

    expect(seen).toContain("connecting");
    expect(seen).toContain("live");
  });
});
