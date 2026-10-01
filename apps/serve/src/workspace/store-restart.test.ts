import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChorusDatabase, resolveDbPath, restoreDatabaseFile } from "./db";
import { WorkspaceStore } from "./store";

/**
 * Integration tests for durability (plan Phase 2).
 *
 * These drive real processes and a real SQLite file rather than mocking: the
 * properties under test — "no acknowledged write is lost across a kill -9",
 * "dedup survives restart", "committed WAL data survives a restore cycle",
 * "shutdown finishes inside its budget" — are exactly the ones a mock cannot
 * speak to.
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chorus-it-"));
  dirs.push(dir);
  return dir;
}

function cleanup() {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
}

const SEED = {
  repo: { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" },
  title: "Repo",
};

/**
 * A child process that opens a store, applies mutations, prints the seqs it
 * committed, and (optionally) hard-exits without a graceful shutdown.
 */
const WORKER = `
import { WorkspaceStore } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};

const [, , dataDir, mode, countRaw] = process.argv;
const count = Number.parseInt(countRaw ?? "0", 10);
const store = new WorkspaceStore(dataDir);
await store.load();

const acknowledged: number[] = [];

const created = await store.applyMutation({
  baseRevision: null, clientId: "worker", mutationId: "seed",
  payload: { seed: ${JSON.stringify(SEED)} }, type: "board.create",
});
if (created) { acknowledged.push(created.lastSeq); }
const boardId = created?.events[0]?.type === "board.created"
  ? created.events[0].board.boardId
  : null;

for (let index = 0; index < count; index += 1) {
  const commit = await store.applyMutation({
    baseRevision: null, clientId: "worker", mutationId: "m" + index,
    payload: { boardId, position: { x: index, y: index } }, type: "board.move",
  });
  if (commit) { acknowledged.push(commit.lastSeq); }
}

if (mode === "kill") {
  // Hard exit: no drain, no final snapshot, no WAL checkpoint.
  process.exit(9);
}

console.log(JSON.stringify({ acknowledged, boardId, headSeq: store.headSeq() }));
await store.close();
`;

describe("crash recovery", () => {
  test("a kill -9 loses no acknowledged write", async () => {
    const dataDir = tempDir();
    const workerPath = join(dataDir, "worker.ts");
    await Bun.write(workerPath, WORKER);

    // First run: commits 5 mutations, then dies without draining.
    const killer = Bun.spawn(["bun", "run", workerPath, dataDir, "kill", "5"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const killerOut = await new Response(killer.stdout).text();
    await killer.exited;

    // The worker died before printing, so reconstruct the acknowledged set from
    // the log itself and assert it is intact and replayable.
    expect(killerOut.trim()).toBe("");

    const store = new WorkspaceStore(dataDir);
    await store.load();

    const snapshot = store.getSnapshot();
    expect(snapshot.boards).toHaveLength(1);
    expect(store.headSeq()).toBe(6);
    // Replay reconstructed every committed mutation: the last position is the
    // final one the dead process acknowledged.
    expect(snapshot.boards[0]?.position).toEqual({ x: 4, y: 4 });

    await store.close();
    await cleanup();
  });

  test("a graceful shutdown checkpoints so a cold copy is complete", async () => {
    const dataDir = tempDir();
    const workerPath = join(dataDir, "worker.ts");
    await Bun.write(workerPath, WORKER);

    const worker = Bun.spawn(
      ["bun", "run", workerPath, dataDir, "clean", "3"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const out = await new Response(worker.stdout).text();
    await worker.exited;

    const parsed = JSON.parse(out.trim()) as {
      acknowledged: number[];
      boardId: string;
      headSeq: number;
    };
    expect(parsed.headSeq).toBe(4);

    // checkpointTruncate ran, so a cold copy of chorus.db alone is a complete
    // backup — no sidecar needed. close() folds the event tail into a snapshot
    // first, so the copy carries state in `snapshots` and only the final event
    // row survives; the sequence head lives in `meta`.
    const copyPath = join(dataDir, "cold-copy.db");
    Bun.spawnSync(["cp", join(dataDir, "chorus.db"), copyPath]);

    const probe = new Database(copyPath);
    expect(probe.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(
      probe.query("SELECT value FROM meta WHERE key = 'head_seq'").get()
    ).toEqual({ value: "4" });
    // load() snapshots once at boot and close() again, so the newest row is the
    // one that matters: it must sit at the final sequence.
    expect(
      probe.query("SELECT seq FROM snapshots ORDER BY seq DESC LIMIT 1").get()
    ).toEqual({ seq: 4 });
    probe.close();

    // And the cold copy boots into identical state.
    const fromCopy = tempDir();
    restoreDatabaseFile(fromCopy, copyPath);
    const reopened = new WorkspaceStore(fromCopy);
    await reopened.load();
    expect(reopened.getSnapshot().boards).toHaveLength(1);
    expect(reopened.getBoard(parsed.boardId)?.position).toEqual({ x: 2, y: 2 });
    expect(reopened.headSeq()).toBe(4);
    await reopened.close();

    await cleanup();
  });

  test("shutdown drains and flushes inside the 5s budget", async () => {
    const dataDir = tempDir();
    const store = new WorkspaceStore(dataDir);
    await store.load();

    const created = await store.applyMutation({
      baseRevision: null,
      clientId: "t",
      mutationId: "seed",
      payload: { seed: SEED },
      type: "board.create",
    });
    const boardId =
      created?.events[0]?.type === "board.created"
        ? created.events[0].board.boardId
        : "";

    // Fire a burst without awaiting, then close: drain() must wait for all of it.
    const pending = Array.from({ length: 100 }, (_unused, index) =>
      store.applyMutation({
        baseRevision: null,
        clientId: "t",
        mutationId: `burst-${index}`,
        payload: { boardId, position: { x: index, y: index } },
        type: "board.move",
      })
    );

    const startedAt = Date.now();
    await store.close();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5000);

    // Every mutation was already committed before close() was called, so none
    // of these reject; the head is read from a fresh handle because the store's
    // connection is closed.
    await Promise.all(pending);

    const probe = new Database(join(dataDir, "chorus.db"));
    expect(
      probe.query("SELECT value FROM meta WHERE key = 'head_seq'").get()
    ).toEqual({ value: "101" });
    probe.close();

    await cleanup();
  });
});

describe("cross-restart idempotency", () => {
  test("a mutation id used before a restart is still deduped after it", async () => {
    const dataDir = tempDir();

    const first = new WorkspaceStore(dataDir);
    await first.load();
    const created = await first.applyMutation({
      baseRevision: null,
      clientId: "c",
      mutationId: "seed",
      payload: { seed: SEED },
      type: "board.create",
    });
    const boardId =
      created?.events[0]?.type === "board.created"
        ? created.events[0].board.boardId
        : "";

    await first.applyMutation({
      baseRevision: null,
      clientId: "c",
      mutationId: "duplicate",
      payload: { boardId, position: { x: 9, y: 9 } },
      type: "board.move",
    });
    const headAfterFirst = first.headSeq();
    await first.close();

    const second = new WorkspaceStore(dataDir);
    await second.load();

    const replay = await second.applyMutation({
      baseRevision: null,
      clientId: "c",
      mutationId: "duplicate",
      payload: { boardId, position: { x: 9, y: 9 } },
      type: "board.move",
    });

    expect(replay).toBeNull();
    expect(second.headSeq()).toBe(headAfterFirst);
    expect(second.getBoard(boardId)?.position).toEqual({ x: 9, y: 9 });

    await second.close();
    await cleanup();
  });

  test("stale idempotency keys are pruned at boot but recent ones survive", async () => {
    const dataDir = tempDir();
    const store = new WorkspaceStore(dataDir);
    await store.load();
    await store.close();

    const db = new Database(resolveDbPath(dataDir));
    const old = Date.now() - 48 * 60 * 60 * 1000;
    db.query(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('mut:old', ?)"
    ).run(String(old));
    db.query(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('mut:fresh', ?)"
    ).run(String(Date.now()));
    db.close();

    const reopened = new WorkspaceStore(dataDir);
    await reopened.load();
    await reopened.close();

    const check = new Database(resolveDbPath(dataDir));
    const rows = check
      .query<{ key: string }, []>("SELECT key FROM meta WHERE key LIKE 'mut:%'")
      .all()
      .map((row) => row.key);
    check.close();

    expect(rows).toEqual(["mut:fresh"]);
    await cleanup();
  });
});

describe("restore and export cycle", () => {
  test("committed WAL data survives export and restore", async () => {
    const sourceDir = tempDir();
    const store = new WorkspaceStore(sourceDir);
    await store.load();
    const created = await store.applyMutation({
      baseRevision: null,
      clientId: "c",
      mutationId: "seed",
      payload: { seed: SEED },
      type: "board.create",
    });
    const boardId =
      created?.events[0]?.type === "board.created"
        ? created.events[0].board.boardId
        : "";
    await store.applyMutation({
      baseRevision: null,
      clientId: "c",
      mutationId: "move",
      payload: { boardId, position: { x: 77, y: 88 } },
      type: "board.move",
    });

    // Deliberately no checkpoint before the export: the data lives in the WAL.
    const exportPath = join(sourceDir, "export.db");
    store.exportTo(exportPath);
    await store.close();

    const restoreDir = tempDir();
    const result = restoreDatabaseFile(restoreDir, exportPath);
    expect(result.integrity).toBe("ok");

    const restored = new WorkspaceStore(restoreDir);
    await restored.load();
    expect(restored.getBoard(boardId)?.position).toEqual({ x: 77, y: 88 });
    expect(restored.getSnapshot().boards).toHaveLength(1);
    expect(restored.headSeq()).toBe(2);
    await restored.close();

    await cleanup();
  });

  test("the restored database is 0600 and writable in place", async () => {
    const sourceDir = tempDir();
    const store = new WorkspaceStore(sourceDir);
    await store.load();
    await store.close();

    const restoreDir = tempDir();
    const result = restoreDatabaseFile(restoreDir, resolveDbPath(sourceDir));

    // biome-ignore lint/suspicious/noBitwiseOperators: mode is a bitfield
    expect(statSync(result.path).mode & 0o777).toBe(0o600);

    // A restored database must accept new writes, not just reads.
    const reopened = new WorkspaceStore(restoreDir);
    await reopened.load();
    await reopened.applyMutation({
      baseRevision: null,
      clientId: "c",
      mutationId: "after-restore",
      payload: { seed: { ...SEED, title: "Post restore" } },
      type: "board.create",
    });
    expect(reopened.getSnapshot().boards).toHaveLength(1);
    await reopened.close();

    await cleanup();
  });

  test("a ChorusDatabase reopened after restore reports a clean head", async () => {
    const sourceDir = tempDir();
    const db = new ChorusDatabase(sourceDir);
    db.appendEvents(
      [
        {
          boardId: "b1",
          payload: JSON.stringify({
            boardId: "b1",
            ts: 1,
            type: "card.started",
          }),
          ts: 1,
          type: "card.started",
        },
      ],
      null
    );
    db.close();

    const restoreDir = tempDir();
    restoreDatabaseFile(restoreDir, resolveDbPath(sourceDir));

    const reopened = new ChorusDatabase(restoreDir);
    expect(reopened.headSeq()).toBe(1);
    expect(reopened.integrityCheck()).toBe("ok");
    reopened.close();

    await cleanup();
  });
});
