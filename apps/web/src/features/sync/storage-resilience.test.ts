import { beforeEach, describe, expect, test } from "bun:test";
import { liveSocket, makeSync, openSocket } from "./test-support";
import { eventFrame, FakeSocket, HostileStorage } from "./testing";

beforeEach(() => FakeSocket.reset());

describe("storage resilience", () => {
  test("a throwing storage degrades to a snapshot rather than a guess", () => {
    const { sync } = makeSync(new HostileStorage());
    const socket = openSocket(sync);
    expect(JSON.parse(socket.sent[0] as string).since).toBe(0);
  });

  test("applying an event with hostile storage still advances the cursor", () => {
    const { sync } = makeSync(new HostileStorage());
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));
    expect(sync.state.lastSeq).toBe(1);
    expect(sync.state.status).toBe("live");
  });

  test("a null storage is tolerated", () => {
    const { sync } = makeSync(null);
    const socket = liveSocket(sync);

    socket.emit(eventFrame(1, 1));

    expect(sync.state.lastSeq).toBe(1);
  });
});
