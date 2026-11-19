import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  createStore,
  createStoreAt,
  createTempDir,
  fileMode,
  mutation,
  seedBoard,
} from "./test-support";

const CORRUPT_SNAPSHOT = /corrupt workspace snapshot/;
const CORRUPT_EVENT = /corrupt event at seq/;

describe("WorkspaceStore durability", () => {
  test("a failed append leaves memory and the log consistent", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const before = store.getSnapshot();

    await store.close();

    await expect(
      store.applyMutation(
        mutation("board.move", { boardId, position: { x: 999, y: 999 } })
      )
    ).rejects.toThrow();

    expect(store.getSnapshot()).toEqual(before);
    expect(store.getBoard(boardId)?.position).toEqual(
      before.boards[0]?.position
    );

    const { Database } = await import("bun:sqlite");
    const db = new Database(store.databasePath);
    expect(db.query("SELECT MAX(seq) AS head FROM events").get()).toEqual({
      head: 1,
    });
    db.close();
  });

  test("chorus.db is created with 0600 permissions", async () => {
    const store = createStore();
    await store.load();
    await store.close();

    expect(statSync(store.databasePath).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(fileMode(store.databasePath)).toBe(0o600);
    }
  });

  test("a corrupt snapshot blob aborts rather than silently emptying", async () => {
    const dir = createTempDir("chorus-corrupt-");

    const first = createStoreAt(dir);
    await first.load();
    await seedBoard(first);
    await first.close();

    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "chorus.db"));
    db.exec("UPDATE snapshots SET blob = 'not-json'");
    db.close();

    const second = createStoreAt(dir);
    await expect(second.load()).rejects.toThrow(CORRUPT_SNAPSHOT);
  });

  test("a corrupt event payload aborts replay", async () => {
    const dir = createTempDir("chorus-bad-event-");

    const first = createStoreAt(dir);
    await first.load();
    await seedBoard(first);

    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "chorus.db"));
    db.exec("UPDATE events SET payload = '{oops'");
    db.close();

    const second = createStoreAt(dir);
    await expect(second.load()).rejects.toThrow(CORRUPT_EVENT);
  });
});

describe("WorkspaceStore export", () => {
  test("exportTo produces a compactable copy of the database", async () => {
    const dir = createTempDir("chorus-export-");

    const store = createStoreAt(dir);
    await store.load();
    await seedBoard(store);
    const destination = join(dir, "backup.db");

    store.exportTo(destination);

    expect(statSync(destination).isFile()).toBe(true);
    const { Database } = await import("bun:sqlite");
    const copy = new Database(destination);
    expect(copy.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(copy.query("SELECT COUNT(*) AS c FROM events").get()).toEqual({
      c: 1,
    });
    copy.close();
  });
});
