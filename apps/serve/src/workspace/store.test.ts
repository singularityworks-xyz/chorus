import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceMutation } from "@chorus/contracts";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { WorkspaceStore } from "./store";

const dirs: string[] = [];

const CORRUPT_SNAPSHOT = /corrupt workspace snapshot/;
const CORRUPT_EVENT = /corrupt event at seq/;
const CORRUPT_LEGACY = /refusing to start.*corrupt/is;

type StoreOptions = ConstructorParameters<typeof WorkspaceStore>[1];

/** POSIX permission bits are a bitmask, so masking is the correct operation. */
function fileMode(path: string): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: mode is a bitfield
  return statSync(path).mode & 0o777;
}

function createStore(options?: StoreOptions) {
  const dir = mkdtempSync(join(tmpdir(), "chorus-store-"));
  dirs.push(dir);
  return new WorkspaceStore(dir, options);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

let mutationCounter = 0;
function mutation<T extends WorkspaceMutation["type"]>(
  type: T,
  payload: Extract<WorkspaceMutation, { type: T }>["payload"]
): Extract<WorkspaceMutation, { type: T }> {
  mutationCounter += 1;
  return {
    baseRevision: null,
    clientId: "test-client",
    mutationId: `mut-${mutationCounter}`,
    payload,
    type,
  } as Extract<WorkspaceMutation, { type: T }>;
}

const SEED = {
  repo: { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" },
  title: "Repo",
};

async function seedBoard(store: WorkspaceStore, title = "Repo") {
  const commit = await store.applyMutation(
    mutation("board.create", { seed: { ...SEED, title } })
  );

  const event = commit?.events[0];
  if (!commit || event?.type !== "board.created") {
    throw new Error("expected a board.created commit");
  }

  return event.board.boardId;
}

/** A board with a live card and bound session — the precondition for agent events. */
async function seedActiveBoard(store: WorkspaceStore) {
  const boardId = await seedBoard(store);

  await store.applyMutation(
    mutation("board.columns.replace", {
      boardId,
      columns: {
        approve: [],
        done: [],
        in_progress: [
          {
            id: "task-1",
            label: "repo",
            labelVariant: "primary-light",
            title: "Do the thing",
          },
        ],
        queue: [],
      },
    })
  );

  await store.applyMutation(
    mutation("board.session.patch", {
      boardId,
      session: {
        currentTaskId: "task-1",
        sessionId: "sess-1",
        state: "active",
      },
    })
  );

  return boardId;
}

function agentEvent(
  overrides: Partial<NormalizedAgentEvent>
): NormalizedAgentEvent {
  return {
    sessionID: "sess-1",
    timestamp: Date.now(),
    type: "message.part.updated",
    ...overrides,
  };
}

describe("WorkspaceStore persistence", () => {
  test("appends board.create as a single sequenced event", async () => {
    const store = createStore();
    await store.load();

    const commit = await store.applyMutation(
      mutation("board.create", { seed: SEED })
    );

    expect(commit).not.toBeNull();
    expect(commit?.events).toHaveLength(1);
    expect(commit?.events[0].type).toBe("board.created");
    expect(commit?.firstSeq).toBe(1);
    expect(commit?.lastSeq).toBe(1);
    expect(store.headSeq()).toBe(1);
    expect(store.getSnapshot().boards).toHaveLength(1);
  });

  test("a reload replays the log into identical state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-replay-"));
    dirs.push(dir);

    const first = new WorkspaceStore(dir);
    await first.load();
    const boardId = await seedBoard(first);
    await first.applyMutation(
      mutation("board.move", { boardId, position: { x: 42, y: 43 } })
    );
    await first.applyMutation(
      mutation("board.model.set", {
        boardId,
        model: { providerID: "anthropic", modelID: "claude" },
      })
    );
    const before = first.getSnapshot();
    await first.close();

    const second = new WorkspaceStore(dir);
    await second.load();

    expect(second.getSnapshot()).toEqual(before);
    expect(second.getBoard(boardId)?.position).toEqual({ x: 42, y: 43 });
    expect(second.getBoard(boardId)?.modelSelection?.modelID).toBe("claude");
    await second.close();
  });

  test("every mutation type produces exactly one event", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const cases: WorkspaceMutation[] = [
      mutation("board.move", { boardId, position: { x: 1, y: 2 } }),
      mutation("board.model.set", { boardId, model: null }),
      mutation("board.review_mode.set", { boardId, reviewMode: "manual" }),
      mutation("board.columns.replace", { boardId, columns: {} }),
      mutation("board.session.patch", {
        boardId,
        session: { state: "active" },
      }),
      mutation("board.task.plan.update", { boardId, taskId: "t1", plan: "p" }),
      mutation("preference.dismiss_composer_hint", {}),
      mutation("preference.speech_voice.set", { voiceId: "hannah" }),
      mutation("preference.set_voice", { voice: "daniel" }),
      mutation("preference.board_view_mode.set", { mode: "stacked" }),
      mutation("preference.recently_used_models.add", {
        model: { providerID: "p", modelID: "m" },
      }),
      mutation("board.select", { boardId }),
    ];

    for (const m of cases) {
      const commit = await store.applyMutation(m);
      expect(commit?.events).toHaveLength(1);
    }
  });

  test("preference.set_voice no longer throws (it did before Phase 2)", async () => {
    const store = createStore();
    await store.load();

    const commit = await store.applyMutation(
      mutation("preference.set_voice", { voice: "daniel" })
    );

    expect(commit?.events[0].type).toBe("preference.speech_voice_set");
    expect(store.getSnapshot().preferences.speechVoiceId).toBe("daniel");
  });
});

describe("WorkspaceStore idempotency", () => {
  test("a repeated mutationId is a no-op", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const repeat = mutation("board.move", {
      boardId,
      position: { x: 7, y: 8 },
    });

    const first = await store.applyMutation(repeat);
    expect(first).not.toBeNull();

    const headAfterFirst = store.headSeq();
    const second = await store.applyMutation(repeat);
    expect(second).toBeNull();
    expect(store.headSeq()).toBe(headAfterFirst);
  });

  test("idempotency survives a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-dedup-"));
    dirs.push(dir);

    const first = new WorkspaceStore(dir);
    await first.load();
    const boardId = await seedBoard(first);

    // Fixed id so the post-restart replay can reuse it verbatim.
    await first.applyMutation({
      baseRevision: null,
      clientId: "test-client",
      mutationId: "repeatable-id",
      payload: { boardId, position: { x: 7, y: 8 } },
      type: "board.move",
    });
    await first.close();

    const second = new WorkspaceStore(dir);
    await second.load();

    const head = second.headSeq();
    const replay = await second.applyMutation({
      baseRevision: null,
      clientId: "test-client",
      mutationId: "repeatable-id",
      payload: { boardId, position: { x: 7, y: 8 } },
      type: "board.move",
    });

    expect(replay).toBeNull();
    expect(second.headSeq()).toBe(head);
    await second.close();
  });

  test("a mutation addressing a missing board is a no-op", async () => {
    const store = createStore();
    await store.load();

    const commit = await store.applyMutation(
      mutation("board.move", { boardId: "ghost", position: { x: 1, y: 1 } })
    );

    expect(commit).toBeNull();
    expect(store.headSeq()).toBe(0);
  });
});

describe("WorkspaceStore serialization", () => {
  test("a parallel mutation storm is serialized and complete", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const storm = await Promise.all(
      Array.from({ length: 200 }, (_unused, index) =>
        store.applyMutation(
          mutation("board.move", {
            boardId,
            position: { x: index, y: index },
          })
        )
      )
    );

    const committed = storm.filter((entry) => entry !== null);
    expect(committed).toHaveLength(200);

    // Exactly one event per mutation, contiguous, no gaps or duplicates.
    const seqs = committed.map((entry) => entry.lastSeq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(2);
    expect(seqs.length).toBe(200);
    expect(seqs.at(-1)).toBe(201);
    expect(store.headSeq()).toBe(201);
    expect(store.getSnapshot().revision).toBe(201);
  });

  test("concurrent agent events and mutations do not interleave", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);

    const results = await Promise.all([
      ...Array.from({ length: 25 }, (_unused, index) =>
        store.applyMutation(
          mutation("board.move", { boardId, position: { x: index, y: 0 } })
        )
      ),
      ...Array.from({ length: 25 }, (_unused, index) =>
        store.applyAgentEvent(
          agentEvent({ activity: "thinking", partID: `p${index}`, text: "x" })
        )
      ),
    ]);

    const commits = results.filter((entry) => entry !== null);
    const seqs = commits.map((entry) => entry.lastSeq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(store.headSeq()).toBe(seqs.at(-1) ?? -1);
  });

  test("drain resolves only after queued work commits", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const queued = Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        store.applyMutation(
          mutation("board.move", { boardId, position: { x: index, y: index } })
        )
      )
    );

    await store.drain();
    await queued;

    expect(store.headSeq()).toBe(51);
  });
});

describe("WorkspaceStore durability", () => {
  test("a failed append leaves memory and the log consistent", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const before = store.getSnapshot();

    // Closing the database is a faithful stand-in for a failed write: the
    // INSERT can no longer succeed. The invariant under test is that memory is
    // not swapped when the append throws. `headSeq()` cannot be read after
    // close, so the sequence assertion happens against a reopened database.
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

    expect(fileMode(store.databasePath)).toBe(0o600);
  });

  test("a corrupt snapshot blob aborts rather than silently emptying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-corrupt-"));
    dirs.push(dir);

    const first = new WorkspaceStore(dir);
    await first.load();
    await seedBoard(first);
    await first.close();

    // Rewrite the newest snapshot row with garbage, leaving no valid base for
    // replay to fall back on.
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "chorus.db"));
    db.exec("UPDATE snapshots SET blob = 'not-json'");
    db.close();

    const second = new WorkspaceStore(dir);
    await expect(second.load()).rejects.toThrow(CORRUPT_SNAPSHOT);
  });

  test("a corrupt event payload aborts replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-bad-event-"));
    dirs.push(dir);

    const first = new WorkspaceStore(dir);
    await first.load();
    await seedBoard(first);

    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "chorus.db"));
    db.exec("UPDATE events SET payload = '{oops'");
    db.close();

    const second = new WorkspaceStore(dir);
    await expect(second.load()).rejects.toThrow(CORRUPT_EVENT);
  });
});

describe("WorkspaceStore snapshots and retention", () => {
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

    // Head survives in meta even though the covered rows are gone. The event
    // *at* the snapshot seq stays until the next snapshot, per spec §5's
    // `seq < snapshotSeq` window.
    expect(store.headSeq()).toBe(2);
    expect(countEvents(store.databasePath)).toBe(1);

    await store.applyMutation(
      mutation("board.move", { boardId, position: { x: 2, y: 2 } })
    );
    await store.writeSnapshot();
    expect(countEvents(store.databasePath)).toBe(1);
  });

  test("state survives a snapshot because the blob carries it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-snap-"));
    dirs.push(dir);

    const first = new WorkspaceStore(dir);
    await first.load();
    const boardId = await seedBoard(first);
    await first.applyMutation(
      mutation("board.move", { boardId, position: { x: 11, y: 12 } })
    );
    await first.writeSnapshot();
    await first.close();

    const second = new WorkspaceStore(dir);
    await second.load();
    expect(second.getBoard(boardId)?.position).toEqual({ x: 11, y: 12 });
    await second.close();
  });

  test("terminal run detail older than retention is compacted", async () => {
    const store = createStore({ retentionDays: 30 });
    await store.load();
    const boardId = await seedBoard(store);

    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await store.applyMutation(
      mutation("board.columns.replace", {
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
      })
    );

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

    await store.applyMutation(
      mutation("board.columns.replace", {
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
      })
    );

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

describe("WorkspaceStore agent events", () => {
  test("an agent event expands into several sequenced events", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);

    const commit = await store.applyAgentEvent(
      agentEvent({ activity: "thinking", partID: "p1", text: "pondering" })
    );

    expect(commit?.boardId).toBe(boardId);
    expect(commit?.events.length).toBeGreaterThan(1);
    expect(commit?.events.map((entry) => entry.type)).toEqual([
      "step.upserted",
      "card.started",
    ]);
  });

  test("agent events for an unknown session are ignored", async () => {
    const store = createStore();
    await store.load();

    expect(
      await store.applyAgentEvent(agentEvent({ activity: "idle" }))
    ).toBeNull();
  });

  test("a completed run survives a restart via replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-agent-"));
    dirs.push(dir);

    const first = new WorkspaceStore(dir);
    await first.load();
    await seedActiveBoard(first);

    await first.applyAgentEvent(
      agentEvent({ activity: "thinking", partID: "p1", text: "work" })
    );
    const before = first.getSnapshot();
    await first.close();

    const second = new WorkspaceStore(dir);
    await second.load();
    expect(second.getSnapshot()).toEqual(before);
    await second.close();
  });
});

describe("WorkspaceStore legacy migration", () => {
  test("a valid workspace.json is imported and parked as .imported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-legacy-"));
    dirs.push(dir);
    const legacyPath = join(dir, "workspace.json");

    writeFileSync(
      legacyPath,
      JSON.stringify({
        boards: [
          {
            boardId: "legacy-1",
            columns: { approve: [], done: [], in_progress: [], queue: [] },
            modelSelection: null,
            position: { x: 5, y: 6 },
            repo: SEED.repo,
            reviewMode: "auto",
            session: { state: "uninitialized" },
            title: "Legacy board",
          },
        ],
        preferences: {
          boardViewMode: "relaxed",
          composerHintDismissed: true,
          recentlyUsedModels: [],
          speechVoiceId: null,
        },
        previousWorkspaces: [],
        revision: 7,
        selectedBoardId: "legacy-1",
      })
    );

    const store = new WorkspaceStore(dir);
    await store.load(legacyPath);

    expect(store.getSnapshot().boards).toHaveLength(1);
    expect(store.getSnapshot().boards[0]?.boardId).toBe("legacy-1");
    expect(store.getSnapshot().preferences.composerHintDismissed).toBe(true);
    // The import lands as a snapshot rather than events, so the log starts empty
    // and the first real mutation is seq 1.
    expect(store.headSeq()).toBe(0);

    const afterImport = await store.applyMutation(
      mutation("board.move", {
        boardId: "legacy-1",
        position: { x: 1, y: 1 },
      })
    );
    expect(afterImport?.firstSeq).toBe(1);

    // The original is parked, not deleted.
    expect(() => statSync(legacyPath)).toThrow();
    expect(statSync(`${legacyPath}.imported`).isFile()).toBe(true);
    await store.close();
  });

  test("a corrupt workspace.json aborts boot instead of emptying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-badlegacy-"));
    dirs.push(dir);
    const legacyPath = join(dir, "workspace.json");
    writeFileSync(legacyPath, "{ this is not json");

    const store = new WorkspaceStore(dir);
    await expect(store.load(legacyPath)).rejects.toThrow(CORRUPT_LEGACY);
  });

  test("a missing legacy file is not an error", async () => {
    const store = createStore();
    await expect(
      store.load(join(tmpdir(), "definitely-absent-workspace.json"))
    ).resolves.toBeUndefined();
  });
});

describe("WorkspaceStore export", () => {
  test("exportTo produces a compactable copy of the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-export-"));
    dirs.push(dir);

    const store = new WorkspaceStore(dir);
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
