import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  portableWorkspaceStateSchema,
  type WorkspaceSnapshot,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import {
  captureWorkspaceState,
  restoreWorkspaceState,
} from "./workspace-state";

function fixture() {
  const repositoryId = crypto.randomUUID();
  const checkoutId = crypto.randomUUID();
  const primaryId = crypto.randomUUID();
  const repository = resolve("tmp/source-project");
  const checkout = join(repository, ".chorus-worktrees", "board-b");
  const authority = {
    workspaceId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    epoch: 4,
  };
  const bindings = [
    { repositoryId, checkoutId: primaryId, repository, checkout: repository },
    { repositoryId, checkoutId, repository, checkout },
  ];
  const repo = {
    directory: repository,
    worktree: checkout,
    projectId: "source-engine-project",
    projectName: "App",
    branch: "feature",
    sandboxes: [checkout],
  };
  const snapshot = workspaceSnapshotSchema.parse({
    boards: [
      {
        boardId: "board-b",
        title: "Build app",
        repo,
        position: { x: 1, y: 2 },
        reviewMode: "manual",
        modelSelection: { providerID: "provider", modelID: "model" },
        session: {
          state: "active",
          sessionId: "source-session",
          currentTaskId: "task-b",
        },
        columns: {
          queue: [],
          in_progress: [
            {
              id: "task-b",
              title: "Feature",
              label: "Build",
              labelVariant: "primary-light",
              taggedFiles: [join(checkout, "src", "app.ts")],
              changedFiles: [{ path: "src/app.ts", added: 1, removed: 0 }],
              runId: "source-run",
              run: {
                elapsed: "1m",
                model: "model",
                taskTitle: "Feature",
                sessionId: "source-session",
                steps: [
                  {
                    id: "step",
                    kind: "file_edit",
                    status: "running",
                    summary: "Edit",
                    filePath: join(checkout, "src", "app.ts"),
                    originalContent: "before",
                    modifiedContent: "after",
                  },
                ],
              },
            },
          ],
          approve: [],
          done: [],
        },
      },
    ],
    selectedBoardId: "board-b",
    revision: 12,
    previousWorkspaces: [
      { id: checkout, lastOpenedAt: 42, repo, title: "App" },
    ],
    preferences: {
      composerHintDismissed: true,
      boardViewMode: "stacked",
      recentlyUsedModels: [],
      speechVoiceId: null,
    },
  });
  const targetRoot = resolve("tmp/target-project");
  const targetCheckout = join(targetRoot, ".chorus-worktrees", "board-b");
  const targetBindings = bindings.map((binding) => ({
    ...binding,
    repository: targetRoot,
    checkout: binding.checkoutId === primaryId ? targetRoot : targetCheckout,
  }));
  return {
    snapshot,
    authority,
    bindings,
    targetBindings,
    targetRoot,
    targetCheckout,
  };
}

describe("portable workspace projection", () => {
  test("maps boards, history and structured file paths without exporting host state", () => {
    const files = fixture();
    const input = {
      ...files.snapshot,
      auth: { token: "fixture-root-secret" },
      push: [{ endpoint: "fixture-device" }],
      credential: "fixture-provider-secret",
    };
    const state = captureWorkspaceState(input, files.authority, files.bindings);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("source-project");
    expect(serialized).not.toContain("source-engine-project");
    expect(serialized).not.toContain("fixture-root-secret");
    expect(serialized).not.toContain("fixture-provider-secret");
    expect(serialized).not.toContain("fixture-device");
    expect(state.boards[0]?.columns.in_progress?.[0]?.taggedFiles).toEqual([
      "src/app.ts",
    ]);
    expect(
      state.boards[0]?.columns.in_progress?.[0]?.run?.steps[0]?.filePath
    ).toBe("src/app.ts");
    expect(state.previousWorkspaces[0]?.id).toBe(
      files.bindings[1]?.checkoutId ?? "missing"
    );
    const restored = restoreWorkspaceState(state, files.targetBindings);
    expect(restored.boards[0]?.repo).toEqual({
      directory: files.targetRoot,
      worktree: files.targetCheckout,
      sandboxes: [files.targetCheckout],
      projectName: "App",
      branch: "feature",
    });
    expect(restored.previousWorkspaces[0]?.id).toBe(files.targetCheckout);
    expect(restored.preferences).toEqual(files.snapshot.preferences);
    expect(restored.selectedBoardId).toBe("board-b");
    expect(restored.revision).toBe(12);
    // Projection is intentionally historical, not an executable continuation.
    expect(restored.boards[0]?.session.sessionId).toBe("source-session");
    expect(restored.boards[0]?.columns.in_progress?.[0]?.runId).toBe(
      "source-run"
    );
    expect(files.snapshot.boards[0]?.repo.projectId).toBe(
      "source-engine-project"
    );
  });
  test("refuses missing, conflicting and cross-repository checkout bindings", () => {
    const files = fixture();
    const state = captureWorkspaceState(
      files.snapshot,
      files.authority,
      files.bindings
    );
    const first = files.targetBindings[0];
    const second = files.targetBindings[1];
    if (!(first && second)) {
      throw new Error("fixture bindings missing");
    }
    for (const bindings of [
      [],
      [second],
      [first, { ...second, repositoryId: crypto.randomUUID() }],
      [first, { ...second, checkoutId: first.checkoutId }],
      [first, { ...second, checkout: first.checkout }],
    ]) {
      expect(() => restoreWorkspaceState(state, bindings)).toThrow(
        "checkpoint_invalid"
      );
    }
    const altered = structuredClone(state);
    if (!altered.boards[0]) {
      throw new Error("fixture board missing");
    }
    altered.boards[0].repo.sandboxCheckoutIds.push(crypto.randomUUID());
    expect(() => restoreWorkspaceState(altered, files.targetBindings)).toThrow(
      "checkpoint_invalid"
    );
    expect(() =>
      captureWorkspaceState(
        files.snapshot,
        files.authority,
        files.bindings.slice(0, 1)
      )
    ).toThrow("checkpoint_invalid");
  });
  test("rejects escaping task file references, duplicate identities and invalid selections", () => {
    const files = fixture();
    const task = files.snapshot.boards[0]?.columns.in_progress?.[0];
    if (!task) {
      throw new Error("fixture task missing");
    }
    task.taggedFiles = ["../outside"];
    expect(() =>
      captureWorkspaceState(files.snapshot, files.authority, files.bindings)
    ).toThrow();
    task.taggedFiles = [resolve("outside.txt")];
    expect(() =>
      captureWorkspaceState(files.snapshot, files.authority, files.bindings)
    ).toThrow();
    task.taggedFiles = ["src/app.ts"];
    const state = captureWorkspaceState(
      files.snapshot,
      files.authority,
      files.bindings
    );
    for (const altered of [
      { ...state, selectedBoardId: "missing" },
      { ...state, boards: [...state.boards, ...state.boards] },
      {
        ...state,
        previousWorkspaces: [
          ...state.previousWorkspaces,
          ...state.previousWorkspaces,
        ],
      },
      { ...state, credential: "not transferable" },
    ]) {
      expect(portableWorkspaceStateSchema.safeParse(altered).success).toBe(
        false
      );
    }
  });
  test("accepts an empty workspace and enforces the state size budget", () => {
    const files = fixture();
    const empty: WorkspaceSnapshot = {
      ...files.snapshot,
      boards: [],
      previousWorkspaces: [],
      selectedBoardId: null,
    };
    const portable = captureWorkspaceState(empty, files.authority, []);
    expect(restoreWorkspaceState(portable, [])).toEqual(empty);
    const board = files.snapshot.boards[0];
    if (!board) {
      throw new Error("fixture board missing");
    }
    board.title = "x".repeat(16 * 1024 * 1024);
    expect(() =>
      captureWorkspaceState(files.snapshot, files.authority, files.bindings)
    ).toThrow("checkpoint_too_large");
  });
});
