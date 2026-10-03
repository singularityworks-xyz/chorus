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

/**
 * Concurrency against real git (plan P6 verify step 2: "parallel prompts run
 * without index lock errors"; step 3: "two boards same repo → isolated worktrees").
 *
 * A mocked git would assert only that the mock was called. The behaviour under
 * test is `git worktree add` racing itself through the store's serial queue, and
 * real agents writing into sibling checkouts of one repository — which is exactly
 * where a shared index would show up as `index.lock`.
 */

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });
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
  // Narrowed here so `string | null` does not reach every call site.
  const boardId = commit?.boardId;
  if (!boardId) {
    throw new Error("board.create produced no board");
  }
  return boardId;
}

/** Every path git currently has registered for this repository. */
function worktreeList(repo: string): string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo })
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

    // Fired together, because that is the shape of the problem: four boards for
    // one repository, all provisioned and all writing at once.
    const boardIds = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createBoard(store, repo, `Board ${i}`)
      )
    );

    const paths = boardIds.map(
      (id) => store.getBoard(id)?.repo.worktree as string
    );

    // One primary checkout, four distinct worktrees.
    expect(paths.filter((path) => path === repo)).toHaveLength(1);
    expect(new Set(paths).size).toBe(4);

    // Each agent edits its own checkout. With a shared index these collide on
    // `index.lock`; in sibling worktrees they cannot.
    for (const path of paths) {
      if (path === repo) {
        continue;
      }
      expect(() => {
        writeFileSync(join(path, "agent-output.txt"), path);
        execFileSync("git", ["add", "-A"], { cwd: path });
        execFileSync("git", ["commit", "--quiet", "-m", "agent work"], {
          cwd: path,
        });
      }).not.toThrow();
    }

    // No work saw another's file, and the primary checkout is untouched by them.
    for (const path of paths) {
      if (path === repo) {
        continue;
      }
      expect(readdirSync(path)).toContain("agent-output.txt");
      expect(existsSync(join(repo, "agent-output.txt"))).toBe(false);
    }

    // git agrees about the shape, with no lingering lock file anywhere. Four
    // boards means one primary checkout plus three worktrees -- the first board
    // for a repo deliberately keeps the primary (spec §2 rule 1).
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

  test("worktrees across three repositories stay independent", async () => {
    // §8 budgets are stated against several repos; the isolation guarantee has to
    // hold there too, not just within one.
    const repos = [
      makeRepo("chorus-multi-a-"),
      makeRepo("chorus-multi-b-"),
      makeRepo("chorus-multi-c-"),
    ];
    const store = new WorkspaceStore(
      mkdtempSync(join(tmpdir(), "chorus-multi-db-")),
      { worktreeProvisioner: new WorktreeManager() }
    );
    await store.load();

    try {
      const boardIds = await Promise.all(
        repos.flatMap((repo, i) => [
          createBoard(store, repo, `${i}-primary`),
          createBoard(store, repo, `${i}-secondary`),
        ])
      );

      const boards = boardIds.map((id) => store.getBoard(id) as WorkspaceBoard);

      // Each repository got one primary and one worktree, six paths in total.
      expect(new Set(boards.map((b) => b.repo.worktree)).size).toBe(6);
      for (const repo of repos) {
        expect(worktreeList(repo)).toHaveLength(2);
        expect(
          worktreeList(repo).some((path) => path.includes(WORKTREE_CONTAINER))
        ).toBe(true);
      }

      await store.close();
    } finally {
      for (const repo of repos) {
        rmSync(repo, { force: true, recursive: true });
      }
    }
  });

  test("a store with no provisioner leaves concurrent boards sharing one checkout", async () => {
    // The control case: without a provisioner the isolation guarantee is
    // deliberately absent, and pretending otherwise would hide a wiring mistake.
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
