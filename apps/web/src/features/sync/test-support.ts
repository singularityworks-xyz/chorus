import { ChorusSync } from "./chorus-sync";
import {
  FakeScheduler,
  FakeSocket,
  FakeStorage,
  type HostileStorage,
  snapshotFixture,
} from "./testing";
import type { ChorusSyncOptions } from "./types";

interface Harness {
  authExpiredCalls: () => number;
  events: unknown[];
  scheduler: FakeScheduler;
  snapshots: { seq: number; snapshot: unknown }[];
  storage: FakeStorage | HostileStorage | null;
  sync: ChorusSync;
}
const TEST_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
function makeSync(
  storage?: FakeStorage | HostileStorage | null,
  overrides?: Partial<ChorusSyncOptions>
): Harness {
  const scheduler = new FakeScheduler();
  const resolvedStorage = storage === undefined ? new FakeStorage() : storage;
  const events: unknown[] = [];
  const snapshots: { seq: number; snapshot: unknown }[] = [];
  let authExpired = 0;

  const sync = new ChorusSync(
    {
      cancel: scheduler.cancel,
      createSocket: (url) => new FakeSocket(url),
      random: () => 1,
      schedule: scheduler.schedule,
      storage: resolvedStorage,
      url: "ws://localhost:2000/ws",
    },
    {
      onAuthExpired: () => {
        authExpired += 1;
      },
      onEvent: (frame) => {
        events.push(frame);
      },
      onSnapshot: (snapshot, seq) => {
        snapshots.push({ seq, snapshot });
      },
      ...overrides,
    }
  );

  return {
    authExpiredCalls: () => authExpired,
    events,
    scheduler,
    snapshots,
    storage: resolvedStorage,
    sync,
  };
}
function openSocket(sync: ChorusSync): FakeSocket {
  sync.start();
  const socket = FakeSocket.last;
  socket.open();
  return socket;
}
function liveSocket(sync: ChorusSync): FakeSocket {
  const socket = openSocket(sync);
  socket.emit({
    head: 0,
    type: "ready",
    workspaceId: TEST_WORKSPACE_ID,
  });
  socket.emit({ data: snapshotFixture(), seq: 0, type: "snapshot" });
  return socket;
}
async function flushPromiseQueue(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

export {
  flushPromiseQueue,
  liveSocket,
  makeSync,
  openSocket,
  REPLACEMENT_WORKSPACE_ID,
  TEST_WORKSPACE_ID,
};
