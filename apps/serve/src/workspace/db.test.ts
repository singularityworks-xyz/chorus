import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChorusDatabase,
  HEAD_SEQ_KEY,
  resolveDbPath,
  restoreDatabaseFile,
} from "./db";

const dirs: string[] = [];
const databases: ChorusDatabase[] = [];

function trackDatabase(database: ChorusDatabase): ChorusDatabase {
  databases.push(database);
  return database;
}

function openAt(directory: string): ChorusDatabase {
  return trackDatabase(new ChorusDatabase(directory));
}

function open(): ChorusDatabase {
  const dir = mkdtempSync(join(tmpdir(), "chorus-db-"));
  dirs.push(dir);
  return openAt(dir);
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => database.close())
  );
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

function event(ts: number, boardId: string | null = "b1") {
  return {
    boardId,
    payload: JSON.stringify({ boardId, ts, type: "card.started" }),
    ts,
    type: "card.started",
  };
}

describe("ChorusDatabase", () => {
  test("creates the spec §5 tables", () => {
    const db = open();
    db.appendEvents([event(1)], null);
    db.close();

    // Queried out-of-band rather than via a new accessor: the schema is the
    // contract, but it is not worth widening the production API to assert it.
    const probe = new Database(resolveDbPath(db.dataDir));
    const tables = probe
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      )
      .all()
      .map((row) => row.name)
      .sort();
    probe.close();

    expect(tables).toEqual([
      "agent_receipts",
      "events",
      "meta",
      "push_subs",
      "snapshots",
    ]);
  });

  test("stores agent receipts and prunes them by age and row cap", () => {
    const db = open();
    db.appendEvents([], null, [], { id: "receipt-old", ts: 10 });
    db.appendEvents([], null, [], { id: "receipt-new-1", ts: 20 });
    db.appendEvents([], null, [], { id: "receipt-new-2", ts: 30 });

    expect(db.hasAgentReceipt("receipt-old")).toBe(true);
    expect(db.hasAgentReceipt("unknown")).toBe(false);

    db.pruneAgentReceipts(15, 1);

    expect(db.hasAgentReceipt("receipt-old")).toBe(false);
    expect(db.hasAgentReceipt("receipt-new-1")).toBe(false);
    expect(db.hasAgentReceipt("receipt-new-2")).toBe(true);
    expect(db.eventCount()).toBe(0);
    expect(db.headSeq()).toBe(0);
    db.close();
  });

  test("rolls back event rows when an agent receipt cannot be inserted", () => {
    const db = open();
    const receipt = { id: "stable-agent-event", ts: 10 };
    db.appendEvents([event(1)], null, [], receipt);

    expect(() => db.appendEvents([event(2)], null, [], receipt)).toThrow();
    expect(db.eventCount()).toBe(1);
    expect(db.headSeq()).toBe(1);
    expect(db.hasAgentReceipt(receipt.id)).toBe(true);
    db.close();
  });

  test("migrates legacy push subscriptions and prevents cross-device replacement", () => {
    const directory = mkdtempSync(join(tmpdir(), "chorus-db-push-migrate-"));
    dirs.push(directory);
    const legacy = new Database(resolveDbPath(directory), { create: true });
    legacy.exec(
      "CREATE TABLE push_subs (endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, created_at INTEGER)"
    );
    legacy
      .query(
        "INSERT INTO push_subs (endpoint, keys, created_at) VALUES (?, ?, ?)"
      )
      .run("https://fcm.googleapis.com/legacy", "{}", 10);
    legacy.close();

    const db = openAt(directory);
    expect(db.listPushSubscriptions()).toEqual([
      {
        createdAt: 10,
        deviceId: null,
        endpoint: "https://fcm.googleapis.com/legacy",
        expirationAt: null,
        keyId: null,
        keys: "{}",
        updatedAt: null,
      },
    ]);

    const row = {
      createdAt: 20,
      deviceId: "a".repeat(32),
      endpoint: "https://fcm.googleapis.com/device",
      expirationAt: null,
      keyId: "key-1",
      keys: JSON.stringify({ auth: "auth", p256dh: "public" }),
      updatedAt: 20,
    };
    expect(db.upsertPushSubscription(row)).toBe("stored");
    expect(db.upsertPushSubscription({ ...row, updatedAt: 25 })).toBe("stored");
    expect(db.pushSubscription(row.endpoint)?.updatedAt).toBe(20);
    expect(
      db.upsertPushSubscription({ ...row, deviceId: "b".repeat(32) })
    ).toBe("owned-by-another-device");
    expect(db.listPushSubscriptions("a".repeat(32))).toHaveLength(1);
    expect(db.deletePushSubscription(row.endpoint, "b".repeat(32))).toBe(false);
    const replacement = {
      ...row,
      keys: JSON.stringify({ auth: "new-auth", p256dh: "new-public" }),
      updatedAt: 30,
    };
    expect(db.upsertPushSubscription(replacement)).toBe("stored");
    expect(db.deletePushSubscriptionIfMatches(row)).toBe(false);
    expect(db.listPushSubscriptions("a".repeat(32))).toEqual([replacement]);
    expect(db.deletePushSubscriptionIfMatches(replacement)).toBe(true);
  });

  test("uses WAL and writes a 0600 database file", () => {
    const db = open();

    const probe = new Database(resolveDbPath(db.dataDir));
    const mode = probe.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    probe.close();

    expect(mode.journal_mode).toBe("wal");
    expect(statSync(db.path).isFile()).toBe(true);
    if (process.platform !== "win32") {
      // biome-ignore lint/suspicious/noBitwiseOperators: mode is a bitfield
      expect(statSync(db.path).mode & 0o777).toBe(0o600);
    }
    db.close();
  });

  test("appends events with contiguous sequence numbers", () => {
    const db = open();

    const first = db.appendEvents([event(1), event(2)], null);
    expect(first).toEqual({ firstSeq: 1, lastSeq: 2 });

    const second = db.appendEvents([event(3)], null);
    expect(second).toEqual({ firstSeq: 3, lastSeq: 3 });

    expect(db.headSeq()).toBe(3);
    expect(db.eventCount()).toBe(3);
    expect(db.readEventsSince(0).map((row) => row.seq)).toEqual([1, 2, 3]);
    db.close();
  });

  test("readEventsSince returns rows in camelCase", () => {
    const db = open();
    db.appendEvents([event(10)], null);

    const [row] = db.readEventsSince(0);
    expect(row.boardId).toBe("b1");
    expect(row.seq).toBe(1);
    expect(row.ts).toBe(10);
    db.close();
  });

  test("readEventsSince is exclusive and honours the limit", () => {
    const db = open();
    db.appendEvents([event(1), event(2), event(3), event(4)], null);

    expect(db.readEventsSince(2).map((row) => row.seq)).toEqual([3, 4]);
    expect(db.readEventsSince(0, 2).map((row) => row.seq)).toEqual([1, 2]);
    db.close();
  });

  test("head survives event pruning because it lives in meta", () => {
    const db = open();
    db.appendEvents([event(1), event(2), event(3)], null);

    db.pruneEventsBefore(3);

    expect(db.eventCount()).toBe(1);
    expect(db.headSeq()).toBe(3);
    expect(db.getMeta(HEAD_SEQ_KEY)).toBe("3");
    db.close();
  });

  test("appending after a full prune does not reuse sequence numbers", () => {
    const db = open();
    db.appendEvents([event(1), event(2)], null);
    db.pruneEventsBefore(2);

    const next = db.appendEvents([event(3)], null);
    expect(next).toEqual({ firstSeq: 3, lastSeq: 3 });
    db.close();
  });

  test("an empty append advances nothing", () => {
    const db = open();
    db.appendEvents([event(1)], null);

    expect(db.appendEvents([], null)).toEqual({ firstSeq: 2, lastSeq: 1 });
    expect(db.headSeq()).toBe(1);
    db.close();
  });

  test("an IMMEDIATE transaction that throws rolls back every row", () => {
    // The store's commit-then-swap invariant rests on this: a failed append
    // must leave the log untouched, not half-written.
    const db = open();

    expect(() =>
      db.appendFailingBatch([
        { boardId: "b1", payload: "{}", ts: 1, type: "card.started" },
        { boardId: "b1", payload: "{}", ts: 2, type: "card.started" },
      ])
    ).toThrow("injected commit failure");

    expect(db.eventCount()).toBe(0);
    expect(db.headSeq()).toBe(0);
    db.close();
  });

  test("mutation idempotency keys round-trip", () => {
    const db = open();

    expect(db.mutationIdSeen("abc")).toBe(false);
    db.appendEvents([event(1)], { id: "abc", ts: 1234 });
    expect(db.mutationIdSeen("abc")).toBe(true);

    db.close();
  });

  test("pruneMutationIds only removes stale mut: keys", () => {
    const db = open();
    const now = Date.now();
    db.setMeta("mut:old", String(now - 48 * 60 * 60 * 1000));
    db.setMeta("mut:new", String(now));
    db.setMeta(HEAD_SEQ_KEY, "7");

    expect(db.pruneMutationIds(now - 24 * 60 * 60 * 1000)).toBe(1);
    expect(db.mutationIdSeen("old")).toBe(false);
    expect(db.mutationIdSeen("new")).toBe(true);
    expect(db.getMeta(HEAD_SEQ_KEY)).toBe("7");
    db.close();
  });

  test("snapshots keep the newest row", () => {
    const db = open();
    db.appendEvents([event(1)], null);
    db.writeSnapshot(1, 100, "first");
    db.writeSnapshot(5, 200, "second");

    const latest = db.latestSnapshot();
    expect(latest?.seq).toBe(5);
    expect(latest?.blob).toBe("second");
    db.close();
  });

  test("integrity check reports ok", () => {
    const db = open();
    expect(db.integrityCheck()).toBe("ok");
    db.close();
  });

  test("exportTo writes a standalone copy", () => {
    const db = open();
    db.appendEvents([event(1), event(2)], null);
    const destination = join(db.dataDir, "export.db");

    db.exportTo(destination);

    const copy = new Database(destination);
    expect(copy.query("SELECT COUNT(*) AS c FROM events").get()).toEqual({
      c: 2,
    });
    copy.close();
    db.close();
  });
});

describe("restoreDatabaseFile", () => {
  test("replaces the database and verifies integrity", () => {
    const source = open();
    source.appendEvents([event(1), event(2)], null);
    source.checkpointTruncate();
    const sourcePath = source.path;
    source.close();

    const targetDir = mkdtempSync(join(tmpdir(), "chorus-restore-"));
    dirs.push(targetDir);

    const result = restoreDatabaseFile(targetDir, sourcePath);

    expect(result.integrity).toBe("ok");
    expect(result.path).toBe(resolveDbPath(targetDir));
    expect(statSync(result.path).isFile()).toBe(true);
    if (process.platform !== "win32") {
      // biome-ignore lint/suspicious/noBitwiseOperators: mode is a bitfield
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }

    const restored = openAt(targetDir);
    expect(restored.eventCount()).toBe(2);
    restored.close();
  });

  test("a stale WAL sidecar does not leak into the restored database", () => {
    // The reason sidecars are cleared: a leftover -wal belongs to the *previous*
    // database and would otherwise be replayed over the replacement. The
    // invariant is about content, not about the file's absence — SQLite
    // legitimately recreates a -wal when a WAL database is opened.
    const source = open();
    source.appendEvents([event(1), event(2)], null);
    source.checkpointTruncate();
    const sourcePath = source.path;
    source.close();

    const targetDir = mkdtempSync(join(tmpdir(), "chorus-stalewal-"));
    dirs.push(targetDir);

    // Give the target its own (different) history, then poison it with a stale
    // sidecar, then restore over the top.
    const targetPath = resolveDbPath(targetDir);
    const victim = openAt(targetDir);
    victim.appendEvents([event(999)], null);
    victim.checkpointTruncate();
    victim.close();
    writeFileSync(`${targetPath}-wal`, "garbage that is not a wal");

    const result = restoreDatabaseFile(targetDir, sourcePath);
    expect(result.integrity).toBe("ok");

    const restored = openAt(targetDir);
    const ts = restored
      .readEventsSince(0)
      .map((row) => row.ts)
      .sort((a, b) => a - b);
    restored.close();

    // Exactly the source's events: the victim's row and the stale WAL are gone.
    expect(ts).toEqual([1, 2]);
  });

  test("reports corruption instead of booting on garbage", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chorus-badrestore-"));
    dirs.push(targetDir);

    const bogusSource = join(targetDir, "bogus.db");
    writeFileSync(bogusSource, "this is not a sqlite database at all");

    const result = restoreDatabaseFile(targetDir, bogusSource);
    expect(result.integrity).not.toBe("ok");
  });
});
