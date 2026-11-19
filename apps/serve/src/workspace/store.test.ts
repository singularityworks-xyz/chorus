import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type WorkspaceMutation,
  workspaceIdSchema,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { restoreDatabaseFile, WORKSPACE_ID_KEY } from "./db";
import { WorkspaceStore } from "./store";

const dirs: string[] = [];
const stores: WorkspaceStore[] = [];

const CORRUPT_SNAPSHOT = /corrupt workspace snapshot/;
const CORRUPT_EVENT = /corrupt event at seq/;
const CORRUPT_LEGACY = /refusing to start.*corrupt/is;
const LEGACY_CHECKOUT_COLLISION = /share checkout/;

type StoreOptions = ConstructorParameters<typeof WorkspaceStore>[1];

/** POSIX permission bits are a bitmask, so masking is the correct operation. */
function fileMode(path: string): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: mode is a bitfield
  return statSync(path).mode & 0o777;
}

function createStore(options?: StoreOptions) {
  const dir = mkdtempSync(join(tmpdir(), "chorus-store-"));
  dirs.push(dir);
  return trackStore(new WorkspaceStore(dir, options));
}

function trackStore(store: WorkspaceStore): WorkspaceStore {
  stores.push(store);
  return store;
}

function createStoreAt(dir: string, options?: StoreOptions): WorkspaceStore {
  return trackStore(new WorkspaceStore(dir, options));
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
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

  await store.applyBoardEvents(boardId, [
    {
      boardId,
      column: "in_progress",
      task: {
        id: "task-1",
        label: "repo",
        labelVariant: "primary-light",
        title: "Do the thing",
      },
      taskId: "task-1",
      ts: Date.now(),
      type: "card.created",
    },
  ]);

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
  test("keeps a stable sync identity for this database and assigns a new one to another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-store-identity-"));
    dirs.push(dir);

    const first = createStoreAt(dir);
    await first.load();
    const firstId = first.workspaceId;
    await first.close();

    const reopened = createStoreAt(dir);
    await reopened.load();
    expect(reopened.workspaceId).toBe(firstId);

    const separate = createStore();
    await separate.load();
    expect(separate.workspaceId).not.toBe(firstId);
  });

  test("repairs a malformed persisted sync identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-store-identity-"));
    dirs.push(dir);

    const first = createStoreAt(dir);
    await first.load();
    const originalId = first.workspaceId;
    first.meta.setMeta(WORKSPACE_ID_KEY, "not-a-uuid");
    await first.close();

    const reopened = createStoreAt(dir);
    await reopened.load();

    expect(reopened.workspaceId).not.toBe(originalId);
    expect(workspaceIdSchema.safeParse(reopened.workspaceId).success).toBe(
      true
    );
  });

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

  test("a stale reorder cannot move a task after it starts", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);
    await store.applyBoardEvents(boardId, [
      {
        type: "board.columns_replaced",
        ts: Date.now(),
        boardId,
        columns: {
          queue: [
            {
              id: "task-a",
              label: "repo",
              labelVariant: "primary-light",
              title: "First task",
            },
            {
              id: "task-b",
              label: "repo",
              labelVariant: "primary-light",
              title: "Second task",
            },
          ],
          in_progress: [],
          approve: [],
          done: [],
        },
      },
    ]);

    await store.applyBoardEvents(boardId, [
      {
        type: "card.started",
        ts: Date.now(),
        boardId,
        taskId: "task-a",
      },
    ]);
    const commit = await store.applyMutation(
      mutation("board.task.reorder", {
        boardId,
        taskId: "task-a",
        column: "queue",
        beforeTaskId: "task-b",
      })
    );

    expect(commit?.events[0].type).toBe("card.reordered");
    expect(
      store.getBoard(boardId)?.columns.in_progress?.map((task) => task.id)
    ).toEqual(["task-a"]);
    expect(
      store.getBoard(boardId)?.columns.queue?.map((task) => task.id)
    ).toEqual(["task-b"]);
  });

  test("a reload replays the log into identical state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-replay-"));
    dirs.push(dir);

    const first = createStoreAt(dir);
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
    await first.applyMutation(
      mutation("preference.default_model.set", {
        model: { providerID: "openai", modelID: "gpt-5" },
      })
    );
    const before = first.getSnapshot();
    await first.close();

    const second = createStoreAt(dir);
    await second.load();

    expect(second.getSnapshot()).toEqual(before);
    expect(second.getBoard(boardId)?.position).toEqual({ x: 42, y: 43 });
    expect(second.getBoard(boardId)?.modelSelection?.modelID).toBe("claude");
    expect(second.getSnapshot().preferences.defaultModelSelection).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
    await second.close();
  });

  test("promotes one unambiguous legacy board model to the global setting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-global-model-migration-"));
    dirs.push(dir);
    const first = createStoreAt(dir);
    await first.load();
    const boardId = await seedBoard(first);
    await first.applyMutation(
      mutation("board.model.set", {
        boardId,
        model: { providerID: "anthropic", modelID: "claude" },
      })
    );
    await first.close();

    const second = createStoreAt(dir);
    await second.load();
    expect(second.getSnapshot().preferences.defaultModelSelection).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });

    const backupPath = join(
      dir,
      "backups",
      "before-global-model-selection-v1.db"
    );
    if (process.platform !== "win32") {
      expect(fileMode(join(dir, "backups"))).toBe(0o700);
    }
    expect(fileMode(backupPath)).toBe(0o600);
    const rollbackDir = mkdtempSync(
      join(tmpdir(), "chorus-global-model-rollback-")
    );
    dirs.push(rollbackDir);
    const restored = restoreDatabaseFile(rollbackDir, backupPath);
    expect(restored.integrity).toBe("ok");

    const backupDatabase = new Database(restored.path, { readonly: true });
    const snapshotRow = backupDatabase
      .query<{ blob: string }, []>(
        "SELECT blob FROM snapshots ORDER BY seq DESC LIMIT 1"
      )
      .get();
    backupDatabase.close();
    if (!snapshotRow) {
      throw new Error(
        "The migration backup did not contain a workspace snapshot."
      );
    }
    const persistedBlob: unknown = JSON.parse(snapshotRow.blob);
    if (
      typeof persistedBlob !== "object" ||
      persistedBlob === null ||
      !("snapshot" in persistedBlob)
    ) {
      throw new Error("The migration backup snapshot has an invalid shape.");
    }
    const backupSnapshot = workspaceSnapshotSchema.parse(
      persistedBlob.snapshot
    );
    expect(backupSnapshot.preferences.defaultModelSelection).toBeNull();
    expect(backupSnapshot.boards[0]?.modelSelection).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });

    const migratedSeq = second.headSeq();
    await second.close();

    const third = createStoreAt(dir);
    await third.load();
    expect(third.getSnapshot().preferences.defaultModelSelection).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });
    expect(third.headSeq()).toBe(migratedSeq);
  });

  test("rehearses migration and rollback with a representative workspace install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-global-model-rehearsal-"));
    dirs.push(dir);
    const initial = createStoreAt(dir);
    await initial.load();

    const boardIds: string[] = [];
    for (const [index, projectName] of ["Alpha", "Beta", "Gamma"].entries()) {
      const directory = `/srv/chorus-rehearsal/${projectName.toLowerCase()}`;
      const commit = await initial.applyMutation(
        mutation("board.create", {
          seed: {
            title: `${projectName} repository`,
            repo: {
              directory,
              projectId: `project-${index + 1}`,
              projectName,
              sandboxes: [],
              worktree: `${directory}/.chorus-worktrees/board-${index + 1}`,
            },
          },
        })
      );
      const event = commit?.events[0];
      if (!commit || event?.type !== "board.created") {
        throw new Error("expected a rehearsal board to be committed");
      }
      boardIds.push(event.board.boardId);
    }

    const [alphaId, betaId, gammaId] = boardIds;
    if (!(alphaId && betaId && gammaId)) {
      throw new Error("representative rehearsal must create three boards");
    }
    await initial.applyMutation(
      mutation("board.model.set", {
        boardId: alphaId,
        model: { providerID: "anthropic", modelID: "claude" },
      })
    );
    await initial.applyMutation(
      mutation("board.review_mode.set", {
        boardId: betaId,
        reviewMode: "manual",
      })
    );
    await initial.applyMutation(
      mutation("board.move", {
        boardId: gammaId,
        position: { x: 640, y: 280 },
      })
    );
    await initial.applyBoardEvents(gammaId, [
      {
        type: "board.columns_replaced",
        ts: Date.now(),
        boardId: gammaId,
        columns: {
          approve: [],
          done: [
            {
              id: "historical-task",
              label: "feature",
              labelVariant: "success-light",
              outcome: "succeeded",
              run: {
                elapsed: "0m 05s",
                model: "anthropic/claude-previous",
                sessionId: "historical-session",
                startedAt: Date.now(),
                steps: [
                  {
                    id: "historical-response",
                    kind: "response",
                    status: "done",
                    summary: "Historical output stays attached to its run.",
                  },
                ],
                taskTitle: "Preserve this completed run",
              },
              title: "Preserve this completed run",
            },
          ],
          in_progress: [],
          queue: [],
        },
      },
    ]);
    await initial.applyMutation(
      mutation("preference.dismiss_composer_hint", {})
    );
    await initial.applyMutation(
      mutation("preference.board_view_mode.set", { mode: "stacked" })
    );
    await initial.applyMutation(
      mutation("preference.recently_used_models.add", {
        model: { providerID: "openai", modelID: "gpt-5" },
      })
    );
    await initial.applyMutation(mutation("board.select", { boardId: betaId }));

    const legacySnapshot = initial.getSnapshot();
    await initial.close();

    const migrated = createStoreAt(dir);
    await migrated.load();
    const migratedSnapshot = migrated.getSnapshot();
    expect(migratedSnapshot.preferences.defaultModelSelection).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });
    expect(migratedSnapshot.boards).toEqual(legacySnapshot.boards);
    expect(migratedSnapshot.selectedBoardId).toBe(
      legacySnapshot.selectedBoardId
    );
    expect(migratedSnapshot.previousWorkspaces).toEqual(
      legacySnapshot.previousWorkspaces
    );
    expect(migratedSnapshot.preferences).toEqual({
      ...legacySnapshot.preferences,
      defaultModelSelection: { providerID: "anthropic", modelID: "claude" },
    });

    const backupPath = join(
      dir,
      "backups",
      "before-global-model-selection-v1.db"
    );
    const rollbackDir = mkdtempSync(
      join(tmpdir(), "chorus-global-model-rehearsal-rollback-")
    );
    dirs.push(rollbackDir);
    const restored = restoreDatabaseFile(rollbackDir, backupPath);
    expect(restored.integrity).toBe("ok");
    const rollbackDatabase = new Database(restored.path, { readonly: true });
    const rollbackSnapshotRow = rollbackDatabase
      .query<{ blob: string }, []>(
        "SELECT blob FROM snapshots ORDER BY seq DESC LIMIT 1"
      )
      .get();
    rollbackDatabase.close();
    if (!rollbackSnapshotRow) {
      throw new Error("restored rollback database has no workspace snapshot");
    }
    const rollbackBlob: unknown = JSON.parse(rollbackSnapshotRow.blob);
    if (
      typeof rollbackBlob !== "object" ||
      rollbackBlob === null ||
      !("snapshot" in rollbackBlob)
    ) {
      throw new Error("restored rollback snapshot has an invalid shape");
    }
    const rollbackSnapshot = workspaceSnapshotSchema.parse(
      rollbackBlob.snapshot
    );
    expect(rollbackSnapshot).toEqual(legacySnapshot);
    expect(
      rollbackSnapshot.boards.find((board) => board.boardId === gammaId)
        ?.columns.done?.[0]?.run?.model
    ).toBe("anthropic/claude-previous");
    await migrated.close();
  });

  test("does not choose between conflicting legacy board models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-global-model-conflict-"));
    dirs.push(dir);
    const first = createStoreAt(dir);
    await first.load();
    const firstBoardId = await seedBoard(first, "First");
    const secondBoardId = await seedBoard(first, "Second");
    await first.applyMutation(
      mutation("board.model.set", {
        boardId: firstBoardId,
        model: { providerID: "anthropic", modelID: "claude" },
      })
    );
    await first.applyMutation(
      mutation("board.model.set", {
        boardId: secondBoardId,
        model: { providerID: "openai", modelID: "gpt-5" },
      })
    );
    await first.close();

    const recovered = createStoreAt(dir);
    await recovered.load();
    expect(
      recovered.getSnapshot().preferences.defaultModelSelection
    ).toBeNull();
    expect(() => statSync(join(dir, "backups"))).toThrow();
  });

  test("refuses to migrate when its existing rollback backup is corrupt", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "chorus-global-model-corrupt-backup-")
    );
    dirs.push(dir);
    const first = createStoreAt(dir);
    await first.load();
    const boardId = await seedBoard(first);
    await first.applyMutation(
      mutation("board.model.set", {
        boardId,
        model: { providerID: "anthropic", modelID: "claude" },
      })
    );
    await first.close();

    const backupDirectory = join(dir, "backups");
    mkdirSync(backupDirectory, { recursive: true });
    writeFileSync(
      join(backupDirectory, "before-global-model-selection-v1.db"),
      "not a SQLite database"
    );

    const recovered = createStoreAt(dir);
    await expect(recovered.load()).rejects.toThrow(
      "existing workspace migration backup is invalid"
    );
    expect(
      recovered.getSnapshot().preferences.defaultModelSelection
    ).toBeNull();
    expect(recovered.getBoard(boardId)?.modelSelection).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });
  });

  test("every mutation type produces exactly one event", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const cases: WorkspaceMutation[] = [
      mutation("board.move", { boardId, position: { x: 1, y: 2 } }),
      mutation("board.model.set", { boardId, model: null }),
      mutation("board.review_mode.set", { boardId, reviewMode: "manual" }),
      mutation("board.task.reorder", {
        boardId,
        column: "queue",
        taskId: "task-missing",
        beforeTaskId: null,
      }),
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
      mutation("preference.default_model.set", {
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

    const first = createStoreAt(dir);
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

    const second = createStoreAt(dir);
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

    expect(statSync(store.databasePath).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(fileMode(store.databasePath)).toBe(0o600);
    }
  });

  test("a corrupt snapshot blob aborts rather than silently emptying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-corrupt-"));
    dirs.push(dir);

    const first = createStoreAt(dir);
    await first.load();
    await seedBoard(first);
    await first.close();

    // Rewrite the newest snapshot row with garbage, leaving no valid base for
    // replay to fall back on.
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "chorus.db"));
    db.exec("UPDATE snapshots SET blob = 'not-json'");
    db.close();

    const second = createStoreAt(dir);
    await expect(second.load()).rejects.toThrow(CORRUPT_SNAPSHOT);
  });

  test("a corrupt event payload aborts replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-bad-event-"));
    dirs.push(dir);

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

describe("WorkspaceStore snapshots and retention", () => {
  test("automatically snapshots after the configured event interval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-auto-snap-"));
    dirs.push(dir);

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

describe("WorkspaceStore agent events", () => {
  test("accepted pending approval resumes the task atomically", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);

    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "edit",
        permissionID: "permission-1",
      })
    );

    expect(
      store.getBoard(boardId)?.columns.approve[0]?.pendingApproval?.requestId
    ).toBe("permission-1");
    expect(
      await store.resolvePendingApproval("sess-1", "permission-1", true)
    ).toBe(true);

    const resumedBoard = store.getBoard(boardId);
    expect(resumedBoard?.columns.approve).toHaveLength(0);
    expect(resumedBoard?.columns.in_progress[0]).toMatchObject({
      id: "task-1",
      pendingApprovals: [],
    });
    expect(
      resumedBoard?.columns.in_progress[0]?.pendingApproval
    ).toBeUndefined();
  });

  test("resolving one of several approvals keeps the task waiting", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);

    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "edit",
        permissionID: "permission-1",
      })
    );
    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "bash",
        permissionID: "permission-2",
      })
    );

    expect(
      await store.resolvePendingApproval("sess-1", "permission-2", true)
    ).toBe(true);
    const waitingBoard = store.getBoard(boardId);
    expect(waitingBoard?.columns.approve).toHaveLength(1);
    expect(waitingBoard?.columns.approve[0]).toMatchObject({
      id: "task-1",
      pendingApprovals: [{ requestId: "permission-1" }],
    });
    expect(waitingBoard?.columns.in_progress).toHaveLength(0);

    expect(
      await store.resolvePendingApproval("sess-1", "permission-1", true)
    ).toBe(true);
    const resumedBoard = store.getBoard(boardId);
    expect(resumedBoard?.columns.approve).toHaveLength(0);
    expect(resumedBoard?.columns.in_progress[0]).toMatchObject({
      id: "task-1",
      pendingApprovals: [],
    });
  });

  test("only one concurrent client can answer a pending approval", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "edit",
        permissionID: "permission-shared",
      })
    );

    let releaseAction: (() => void) | undefined;
    let markActionStarted: (() => void) | undefined;
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve;
    });
    let actionCalls = 0;
    const firstResponse = store.runPendingApprovalAction(
      "sess-1",
      "permission-shared",
      async () => {
        actionCalls += 1;
        markActionStarted?.();
        await actionGate;
        return true;
      },
      { accepts: (accepted) => accepted, resume: true }
    );

    await actionStarted;
    const secondResponse = await store.runPendingApprovalAction(
      "sess-1",
      "permission-shared",
      () => {
        actionCalls += 1;
        return Promise.resolve(true);
      },
      { accepts: (accepted) => accepted, resume: true }
    );
    expect(secondResponse).toEqual({ status: "already_resolving" });
    expect(actionCalls).toBe(1);

    releaseAction?.();
    expect(await firstResponse).toEqual({ status: "accepted", value: true });
    expect(store.getBoard(boardId)?.columns.in_progress[0]).toMatchObject({
      id: "task-1",
      pendingApprovals: [],
    });
  });

  test("failed provider responses leave requests retryable", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "edit",
        permissionID: "permission-retry",
      })
    );

    await expect(
      store.runPendingApprovalAction("sess-1", "permission-retry", () =>
        Promise.reject(new Error("provider unavailable"))
      )
    ).rejects.toThrow("provider unavailable");
    expect(
      store.getBoard(boardId)?.columns.approve[0]?.pendingApproval?.requestId
    ).toBe("permission-retry");

    const retried = await store.runPendingApprovalAction(
      "sess-1",
      "permission-retry",
      async () => true,
      { accepts: (accepted) => accepted, resume: true }
    );
    expect(retried).toEqual({ status: "accepted", value: true });
  });

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

  test("coalesces streamed deltas without losing per-event idempotency", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-agent-delta-batch-"));
    dirs.push(dir);
    const store = createStoreAt(dir);
    await store.load();
    const boardId = await seedActiveBoard(store);
    const startingSeq = store.headSeq();
    const deltas = ["first ", "second ", "third"].map((delta, index) =>
      agentEvent({
        delta,
        messageID: "message-batched",
        partID: "part-batched",
        sourceEventId: `delta-${index}`,
        timestamp: Date.now() + index,
      })
    );

    const commits = await Promise.all(
      deltas.map((event) => store.applyAgentEvent(event))
    );

    expect(commits[0]).not.toBeNull();
    expect(commits.every((commit) => commit === commits[0])).toBe(true);
    expect(commits[0]?.boardId).toBe(boardId);
    expect(commits[0]?.events).toHaveLength(1);
    expect(commits[0]?.events[0]).toMatchObject({
      delta: "first second third",
      stepId: "part-msg-message-batched-part-batched",
      taskId: "task-1",
      type: "step.delta_appended",
    });
    expect(store.headSeq()).toBe(startingSeq + 1);
    expect(
      store.getBoard(boardId)?.columns.in_progress[0]?.run?.steps[0]?.content
    ).toBe("first second third");

    const replayed = createStoreAt(dir);
    await replayed.load();
    const replayedHead = replayed.headSeq();
    for (const event of deltas) {
      expect(await replayed.applyAgentEvent(event)).toBeNull();
    }
    expect(replayed.headSeq()).toBe(replayedHead);
    expect(
      replayed.getBoard(boardId)?.columns.in_progress[0]?.run?.steps[0]?.content
    ).toBe("first second third");
  });

  test("keeps distinct streamed steps separate in the same batch", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    const commits = await Promise.all([
      store.applyAgentEvent(
        agentEvent({
          delta: "thinking output",
          messageID: "message-multiple-steps",
          partID: "thinking-part",
        })
      ),
      store.applyAgentEvent(
        agentEvent({
          delta: "response output",
          messageID: "message-multiple-steps",
          partID: "response-part",
        })
      ),
    ]);

    expect(commits[0]).not.toBeNull();
    expect(commits.every((commit) => commit === commits[0])).toBe(true);
    expect(commits[0]?.boardId).toBe(boardId);
    expect(
      commits[0]?.events.map((event) =>
        event.type === "step.delta_appended"
          ? { delta: event.delta, stepId: event.stepId }
          : event
      )
    ).toEqual([
      {
        delta: "thinking output",
        stepId: "part-msg-message-multiple-steps-thinking-part",
      },
      {
        delta: "response output",
        stepId: "part-msg-message-multiple-steps-response-part",
      },
    ]);
  });

  test("drops late streamed text after the session releases its task", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    await store.applyAgentEvent(agentEvent({ activity: "idle" }));
    const startingSeq = store.headSeq();

    expect(store.getBoard(boardId)?.session.currentTaskId).toBeUndefined();
    expect(
      await store.applyAgentEvent(
        agentEvent({
          delta: "late text",
          messageID: "message-after-idle",
          partID: "part-after-idle",
          sourceEventId: "late-delta-after-idle",
        })
      )
    ).toBeNull();
    expect(store.headSeq()).toBe(startingSeq);
    expect(store.getBoard(boardId)?.columns.in_progress).toHaveLength(0);
    expect(store.getBoard(boardId)?.columns.done[0]?.run?.steps ?? []).toEqual(
      []
    );
  });

  test("flushes buffered text before a later lifecycle event", async () => {
    const store = createStore();
    await store.load();
    await seedActiveBoard(store);
    const startingSeq = store.headSeq();

    const deltaCommit = store.applyAgentEvent(
      agentEvent({
        delta: "output before idle",
        messageID: "message-barrier",
        partID: "part-barrier",
      })
    );
    const idleCommit = store.applyAgentEvent(agentEvent({ activity: "idle" }));
    const [delta, idle] = await Promise.all([deltaCommit, idleCommit]);
    const appended = store
      .eventsSince(startingSeq)
      .map(({ event }) => event.type);

    expect(delta?.events.map((event) => event.type)).toEqual([
      "step.delta_appended",
    ]);
    expect(idle?.events.map((event) => event.type)).toEqual(["session.idle"]);
    expect(appended).toEqual(["step.delta_appended", "session.idle"]);
  });

  test("flushes buffered text before a later client mutation", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    const startingSeq = store.headSeq();

    const deltaCommit = store.applyAgentEvent(
      agentEvent({
        delta: "output before move",
        messageID: "message-mutation-barrier",
        partID: "part-mutation-barrier",
      })
    );
    const mutationCommit = store.applyMutation(
      mutation("board.move", { boardId, position: { x: 20, y: 30 } })
    );
    const [delta, moved] = await Promise.all([deltaCommit, mutationCommit]);
    const appended = store
      .eventsSince(startingSeq)
      .map(({ event }) => event.type);

    expect(delta?.events.map((event) => event.type)).toEqual([
      "step.delta_appended",
    ]);
    expect(moved?.events.map((event) => event.type)).toEqual(["board.moved"]);
    expect(appended).toEqual(["step.delta_appended", "board.moved"]);
  });

  test("flushes pending streamed text before drain and graceful close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-agent-delta-close-"));
    dirs.push(dir);
    const store = createStoreAt(dir);
    await store.load();
    const boardId = await seedActiveBoard(store);
    const event = agentEvent({
      delta: "persisted on close",
      messageID: "message-close",
      partID: "part-close",
      sourceEventId: "delta-before-close",
    });

    const pendingCommit = store.applyAgentEvent(event);
    await store.drain();
    expect((await pendingCommit)?.events).toHaveLength(1);
    await store.close();

    const restarted = createStoreAt(dir);
    await restarted.load();
    expect(
      restarted.getBoard(boardId)?.columns.in_progress[0]?.run?.steps[0]
        ?.content
    ).toBe("persisted on close");
    expect(await restarted.applyAgentEvent(event)).toBeNull();
  });

  test("completes an accepted mutation that is queued before graceful close", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "chorus-agent-delta-close-mutation-")
    );
    dirs.push(dir);
    const store = createStoreAt(dir);
    await store.load();
    const boardId = await seedActiveBoard(store);
    const deltaCommit = store.applyAgentEvent(
      agentEvent({
        delta: "output before move",
        messageID: "message-close-mutation",
        partID: "part-close-mutation",
      })
    );
    const mutationCommit = store.applyMutation(
      mutation("board.move", { boardId, position: { x: 20, y: 30 } })
    );
    const close = store.close();

    const [delta, moved] = await Promise.all([deltaCommit, mutationCommit]);
    await close;

    expect(delta?.events.map((event) => event.type)).toEqual([
      "step.delta_appended",
    ]);
    expect(moved?.events.map((event) => event.type)).toEqual(["board.moved"]);
    expect(moved?.firstSeq).toBe((delta?.lastSeq ?? 0) + 1);

    const restarted = createStoreAt(dir);
    await restarted.load();
    expect(restarted.getBoard(boardId)?.position).toEqual({ x: 20, y: 30 });
    expect(
      restarted.getBoard(boardId)?.columns.in_progress[0]?.run?.steps[0]
        ?.content
    ).toBe("output before move");
  });

  test("deduplicates recovered agent events across store restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-agent-receipt-"));
    dirs.push(dir);
    const first = createStoreAt(dir);
    await first.load();
    await seedActiveBoard(first);
    const recoveredEvent = agentEvent({
      activity: "writing",
      messageID: "message-1",
      partID: "part-1",
      sourceEventId: "history:message-1:part-1",
      text: "recovered output",
    });

    const originalCommit = await first.applyAgentEvent(recoveredEvent);
    const headAfterFirstDelivery = first.headSeq();
    expect(originalCommit).not.toBeNull();
    expect(await first.applyAgentEvent(recoveredEvent)).toBeNull();
    expect(first.headSeq()).toBe(headAfterFirstDelivery);
    await first.close();

    const restarted = createStoreAt(dir);
    await restarted.load();
    expect(await restarted.applyAgentEvent(recoveredEvent)).toBeNull();
    expect(restarted.headSeq()).toBe(headAfterFirstDelivery);
    await restarted.close();
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

    const first = createStoreAt(dir);
    await first.load();
    await seedActiveBoard(first);

    await first.applyAgentEvent(
      agentEvent({ activity: "thinking", partID: "p1", text: "work" })
    );
    const before = first.getSnapshot();
    await first.close();

    const second = createStoreAt(dir);
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

    const store = createStoreAt(dir);
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

  test("rejects legacy boards that share a checkout and preserves the source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-legacy-collision-"));
    dirs.push(dir);
    const legacyPath = join(dir, "workspace.json");
    const board = (boardId: string) => ({
      boardId,
      columns: { approve: [], done: [], in_progress: [], queue: [] },
      modelSelection: null,
      position: { x: 0, y: 0 },
      repo: SEED.repo,
      reviewMode: "auto",
      session: { state: "uninitialized" },
      title: `Legacy ${boardId}`,
    });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        boards: [board("legacy-1"), board("legacy-2")],
        preferences: {
          boardViewMode: "relaxed",
          composerHintDismissed: false,
          recentlyUsedModels: [],
          speechVoiceId: null,
        },
        previousWorkspaces: [],
        revision: 1,
        selectedBoardId: "legacy-1",
      })
    );

    const store = createStoreAt(dir);
    await expect(store.load(legacyPath)).rejects.toThrow(
      LEGACY_CHECKOUT_COLLISION
    );

    expect(statSync(legacyPath).isFile()).toBe(true);
    expect(() => statSync(`${legacyPath}.imported`)).toThrow();
  });

  test("a corrupt workspace.json aborts boot instead of emptying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-badlegacy-"));
    dirs.push(dir);
    const legacyPath = join(dir, "workspace.json");
    writeFileSync(legacyPath, "{ this is not json");

    const store = createStoreAt(dir);
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
