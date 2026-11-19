import { describe, expect, test } from "bun:test";
import {
  createStore,
  createStoreAt,
  createTempDir,
  mutation,
  SEED,
  seedBoard,
} from "./test-support";

describe("WorkspaceStore snapshots and retention", () => {
  test("automatically snapshots after the configured event interval", async () => {
    const dir = createTempDir("chorus-auto-snap-");

    const store = createStoreAt(dir, { snapshotInterval: 2 });
    await store.load();
    const boardId = await seedBoard(store);
    await store.applyMutation(
      mutation("board.move", { boardId, position: { x: 5, y: 5 } })
    );

    const { Database } = await import("bun:sqlite");
    const db = new Database(store.databasePath);
    const count = db.query("SELECT COUNT(*) AS c FROM events").get() as {
      c: number;
    };
    db.close();

    expect(store.headSeq()).toBe(2);
    expect(count.c).toBe(1);
    expect(store.getBoard(boardId)?.position).toEqual({ x: 5, y: 5 });

    await store.close();
    const recovered = createStoreAt(dir);
    await recovered.load();
    expect(recovered.getBoard(boardId)?.position).toEqual({ x: 5, y: 5 });
    await recovered.close();
  });

  test("a snapshot failure does not fail an already durable mutation", async () => {
    const store = createStore({ snapshotInterval: 1 });
    await store.load();
    const { Database } = await import("bun:sqlite");
    const db = new Database(store.databasePath);
    db.exec(`
      CREATE TRIGGER reject_snapshot_insert
      BEFORE INSERT ON snapshots
      BEGIN SELECT RAISE(FAIL, 'snapshot unavailable'); END;
    `);

    try {
      const commit = await store.applyMutation(
        mutation("board.create", { seed: SEED })
      );
      const boardId =
        commit?.events[0]?.type === "board.created"
          ? commit.events[0].board.boardId
          : undefined;

      expect(boardId).toBeDefined();
      expect(commit?.lastSeq).toBe(1);
      expect(store.getBoard(boardId ?? "")?.title).toBe("Repo");
    } finally {
      db.exec("DROP TRIGGER IF EXISTS reject_snapshot_insert");
      db.close();
    }
  });

  test("writeSnapshot folds the covered events away", async () => {
    const store = createStore({ snapshotInterval: 1000 });
    await store.load();
    const boardId = await seedBoard(store);
    await store.applyMutation(
      mutation("board.move", { boardId, position: { x: 5, y: 5 } })
    );

    const { Database } = await import("bun:sqlite");
    const countEvents = (path: string) => {
      const db = new Database(path);
      const row = db.query("SELECT COUNT(*) AS c FROM events").get() as {
        c: number;
      };
      db.close();
      return row.c;
    };

    await store.writeSnapshot();

    expect(store.headSeq()).toBe(2);
    expect(countEvents(store.databasePath)).toBe(1);

    await store.applyMutation(
      mutation("board.move", { boardId, position: { x: 2, y: 2 } })
    );
    await store.writeSnapshot();
    expect(countEvents(store.databasePath)).toBe(1);
  });

  test("state survives a snapshot because the blob carries it", async () => {
    const dir = createTempDir("chorus-snap-");

    const first = createStoreAt(dir);
    await first.load();
    const boardId = await seedBoard(first);
    await first.applyMutation(
      mutation("board.move", { boardId, position: { x: 11, y: 12 } })
    );
    await first.writeSnapshot();
    await first.close();

    const second = createStoreAt(dir);
    await second.load();
    expect(second.getBoard(boardId)?.position).toEqual({ x: 11, y: 12 });
    await second.close();
  });

  test("terminal run detail older than retention is compacted", async () => {
    const store = createStore({ retentionDays: 30 });
    await store.load();
    const boardId = await seedBoard(store);

    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await store.applyBoardEvents(boardId, [
      {
        type: "board.columns_replaced",
        ts: Date.now(),
        boardId,
        columns: {
          approve: [],
          done: [
            {
              id: "task-old",
              label: "repo",
              labelVariant: "success-light",
              title: "Old work",
              run: {
                elapsed: "1m 00s",
                model: "claude",
                startedAt: old,
                steps: [
                  { id: "s1", kind: "thinking", status: "done", summary: "a" },
                  { id: "s2", kind: "response", status: "done", summary: "b" },
                ],
                taskTitle: "Old work",
              },
            },
          ],
          in_progress: [],
          queue: [],
        },
      },
    ]);

    await store.runRetention();

    const card = store.getBoard(boardId)?.columns.done?.[0];
    expect(card?.id).toBe("task-old");
    expect(card?.run?.steps).toHaveLength(1);
    expect(card?.run?.steps[0].summary).toBe("b");
  });

  test("recent terminal runs keep their detail", async () => {
    const store = createStore({ retentionDays: 30 });
    await store.load();
    const boardId = await seedBoard(store);

    await store.applyBoardEvents(boardId, [
      {
        type: "board.columns_replaced",
        ts: Date.now(),
        boardId,
        columns: {
          approve: [],
          done: [
            {
              id: "task-new",
              label: "repo",
              labelVariant: "success-light",
              title: "New work",
              run: {
                elapsed: "0m 05s",
                model: "claude",
                startedAt: Date.now(),
                steps: [
                  { id: "s1", kind: "thinking", status: "done", summary: "a" },
                  { id: "s2", kind: "response", status: "done", summary: "b" },
                ],
                taskTitle: "New work",
              },
            },
          ],
          in_progress: [],
          queue: [],
        },
      },
    ]);

    await store.runRetention();

    expect(store.getBoard(boardId)?.columns.done?.[0].run?.steps).toHaveLength(
      2
    );
  });

  test("compaction triggers when the database passes its cap", async () => {
    const store = createStore({ dbSizeCapMb: 0.000_001 });
    await store.load();
    const boardId = await seedBoard(store);
    await store.applyMutation(
      mutation("board.move", { boardId, position: { x: 1, y: 1 } })
    );

    expect(await store.compactIfOversized()).toBe(true);

    const { Database } = await import("bun:sqlite");
    const db = new Database(store.databasePath);
    const events = db.query("SELECT COUNT(*) AS c FROM events").get() as {
      c: number;
    };
    db.close();
    expect(events.c).toBe(1);
  });
});
