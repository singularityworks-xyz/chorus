import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceSnapshotSchema } from "@chorus/contracts";
import { restoreDatabaseFile } from "../../testing/restore-database-file";
import {
  createStoreAt,
  createTempDir,
  fileMode,
  mutation,
  seedBoard,
} from "../test-support";

describe("WorkspaceStore model migration", () => {
  test("promotes one unambiguous legacy board model to the global setting", async () => {
    const dir = createTempDir("chorus-global-model-migration-");
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
    const rollbackDir = createTempDir("chorus-global-model-rollback-");
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
    const dir = createTempDir("chorus-global-model-rehearsal-");
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
    const rollbackDir = createTempDir(
      "chorus-global-model-rehearsal-rollback-"
    );
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
    const dir = createTempDir("chorus-global-model-conflict-");
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
    const dir = createTempDir("chorus-global-model-corrupt-backup-");
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
});
