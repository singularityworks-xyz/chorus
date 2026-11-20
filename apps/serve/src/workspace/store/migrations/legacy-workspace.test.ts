import { describe, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  createStoreAt,
  createTempDir,
  mutation,
  SEED,
} from "../test-support";

const CORRUPT_LEGACY = /refusing to start.*corrupt/is;
const LEGACY_CHECKOUT_COLLISION = /share checkout/;

describe("WorkspaceStore legacy migration", () => {
  test("a valid workspace.json is imported and parked as .imported", async () => {
    const dir = createTempDir("chorus-legacy-");
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

    expect(store.headSeq()).toBe(0);

    const afterImport = await store.applyMutation(
      mutation("board.move", {
        boardId: "legacy-1",
        position: { x: 1, y: 1 },
      })
    );
    expect(afterImport?.firstSeq).toBe(1);

    expect(() => statSync(legacyPath)).toThrow();
    expect(statSync(`${legacyPath}.imported`).isFile()).toBe(true);
    await store.close();
  });

  test("rejects legacy boards that share a checkout and preserves the source", async () => {
    const dir = createTempDir("chorus-legacy-collision-");
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
    const dir = createTempDir("chorus-badlegacy-");
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
