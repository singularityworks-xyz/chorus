import { describe, expect, test } from "bun:test";
import {
  clearPersistedState,
  LEGACY_LAST_SEQ_KEY,
  MAX_PERSISTED_SNAPSHOT_BYTES,
  readPersistedSnapshot,
  SNAPSHOT_KEY,
  writePersistedSnapshot,
} from "./snapshot-storage";
import { FakeStorage } from "./testing";

const TEST_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

describe("persisted sync snapshot", () => {
  test("stores the resume sequence with its snapshot", () => {
    const storage = new FakeStorage();
    const snapshot = { boards: [], preferences: {} };

    writePersistedSnapshot(storage, snapshot, 42, TEST_WORKSPACE_ID);

    expect(readPersistedSnapshot(storage)).toEqual({
      seq: 42,
      snapshot,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(storage.getItem(LEGACY_LAST_SEQ_KEY)).toBeNull();
  });

  test("rejects malformed or incomplete records", () => {
    const storage = new FakeStorage();
    for (const raw of ["{broken", '{"seq":-1}', '{"seq":1}', "null", "[]"]) {
      storage.setItem(SNAPSHOT_KEY, raw);
      expect(readPersistedSnapshot(storage)).toBeNull();
    }
  });

  test("measures the persisted size in UTF-8 bytes", () => {
    const storage = new FakeStorage();
    writePersistedSnapshot(
      storage,
      { text: "界".repeat(Math.ceil(MAX_PERSISTED_SNAPSHOT_BYTES / 3)) },
      1
    );

    expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  test("clears the current snapshot and legacy cursor together", () => {
    const storage = new FakeStorage();
    storage.setItem(SNAPSHOT_KEY, '{"seq":1,"snapshot":{}}');
    storage.setItem(LEGACY_LAST_SEQ_KEY, "1");

    clearPersistedState(storage);

    expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_LAST_SEQ_KEY)).toBeNull();
  });
});
