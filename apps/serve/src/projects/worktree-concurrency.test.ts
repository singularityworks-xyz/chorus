import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBoard } from "@chorus/contracts";
import { WorkspaceStore, type WorktreeProvisioner } from "../workspace/store";
import { WORKTREE_CONTAINER, WorktreeManager } from "./worktree-manager";

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: dir,
    windowsHide: true,
  });
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["commit", "--quiet", "-m", "init"], {
    cwd: dir,
    windowsHide: true,
  });
  return dir;
}

async function createBoard(
  store: WorkspaceStore,
  directory: string,
  title: string
): Promise<string> {
  const commit = await store.applyMutation({
    baseRevision: null,
    clientId: "concurrency-test",
    mutationId: `board-${crypto.randomUUID()}`,
    payload: {
      seed: { repo: { directory, sandboxes: [], worktree: directory }, title },
    },
    type: "board.create",
  });

  const boardId = commit?.boardId;
  if (!boardId) {
    throw new Error("board.create produced no board");
  }
  return boardId;
}

function worktreeList(repo: string): string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    windowsHide: true,
  })
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

describe("parallel worktree writes", () => {
  test("four concurrent boards commit into their own worktrees without an index lock", async () => {
    const repo = makeRepo("chorus-parallel-");
    const store = new WorkspaceStore(
      mkdtempSync(join(tmpdir(), "chorus-parallel-db-")),
      { worktreeProvisioner: new WorktreeManager() }
    );
    await store.load();

    const boardIds = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createBoard(store, repo, `Board ${i}`)
      )
    );

    const paths = boardIds.map(
      (id) => store.getBoard(id)?.repo.worktree as string
    );

    expect(paths.filter((path) => path === repo)).toHaveLength(1);
    expect(new Set(paths).size).toBe(4);

    for (const path of paths) {
      if (path === repo) {
        continue;
      }
      expect(() => {
        writeFileSync(join(path, "agent-output.txt"), path);
        execFileSync("git", ["add", "-A"], {
          cwd: path,
          windowsHide: true,
        });
        execFileSync("git", ["commit", "--quiet", "-m", "agent work"], {
          cwd: path,
          windowsHide: true,
        });
      }).not.toThrow();
    }

    for (const path of paths) {
      if (path === repo) {
        continue;
      }
      expect(readdirSync(path)).toContain("agent-output.txt");
      expect(existsSync(join(repo, "agent-output.txt"))).toBe(false);
    }

    expect(worktreeList(repo)).toHaveLength(4);
    expect(
      worktreeList(repo).filter((path) => path.includes(WORKTREE_CONTAINER))
    ).toHaveLength(3);
    expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
    for (const path of paths) {
      if (path === repo) {
        continue;
      }
      expect(existsSync(join(path, ".git"))).toBe(true);
    }

    await store.close();
    rmSync(repo, { force: true, recursive: true });
  });

  test("eight concurrent boards across three repositories stay isolated", async () => {
    const repos = [
      makeRepo("chorus-eight-a-"),
      makeRepo("chorus-eight-b-"),
      makeRepo("chorus-eight-c-"),
    ];
    const store = new WorkspaceStore(
      mkdtempSync(join(tmpdir(), "chorus-eight-db-")),
      { worktreeProvisioner: new WorktreeManager() }
    );
    await store.load();

    const layout = [3, 3, 2];

    try {
      const boardIds = await Promise.all(
        repos.flatMap((repo, repoIndex) =>
          Array.from({ length: layout[repoIndex] ?? 0 }, (_, boardIndex) =>
            createBoard(store, repo, `repo-${repoIndex}-board-${boardIndex}`)
          )
        )
      );

      const boards = boardIds.map((id) => store.getBoard(id) as WorkspaceBoard);
      expect(boards).toHaveLength(8);

      const paths = boards.map((board) => board.repo.worktree);
      expect(new Set(paths).size).toBe(8);

      for (const [index, repo] of repos.entries()) {
        const expected = layout[index] ?? 0;

        expect(worktreeList(repo)).toHaveLength(expected);
        expect(
          worktreeList(repo).filter((path) => path.includes(WORKTREE_CONTAINER))
        ).toHaveLength(expected - 1);
        expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
      }

      await store.close();
    } finally {
      for (const repo of repos) {
        rmSync(repo, { force: true, recursive: true });
      }
    }
  });

  test("a store with no provisioner leaves concurrent boards sharing one checkout", async () => {
    const repo = makeRepo("chorus-noprov-");
    const store = new WorkspaceStore(
      mkdtempSync(join(tmpdir(), "chorus-noprov-db-"))
    );

    await store.load();
    await Promise.all([
      createBoard(store, repo, "a"),
      createBoard(store, repo, "b"),
    ]);

    const paths = store
      .getSnapshot()
      .boards.map((board) => board.repo.worktree);
    expect(paths).toEqual([repo, repo]);

    const noProvisioner: WorktreeProvisioner | undefined = undefined;
    expect(noProvisioner).toBeUndefined();

    await store.close();
    rmSync(repo, { force: true, recursive: true });
  });
});
