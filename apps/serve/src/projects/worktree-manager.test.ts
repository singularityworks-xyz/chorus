import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SandboxEscapeError } from "../paths/sandbox";
import { WorkspaceStore, type WorktreeProvisioner } from "../workspace/store";
import { WORKTREE_CONTAINER, WorktreeManager } from "./worktree-manager";

const NOT_A_REPO = /not a git repository/;

/**
 * Worktree-per-board (spec §2 rule 1, plan P6 task 2).
 *
 * These run against real git in a real repository. The behaviour under test is
 * `git worktree add` interacting with a concurrent queue, and a mock would
 * assert only that the mock was called.
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

function worktreeList(repo: string): string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
  })
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
}

async function seedBoard(
  store: WorkspaceStore,
  directory: string
): Promise<string> {
  const commit = await store.applyMutation({
    baseRevision: null,
    clientId: "worktree-test",
    mutationId: `board-${crypto.randomUUID()}`,
    payload: {
      seed: {
        repo: { directory, sandboxes: [], worktree: directory },
        title: "Board",
      },
    },
    type: "board.create",
  });
  // Narrowed once here so callers do not juggle a nullable id.
  const boardId = commit?.boardId;
  if (!boardId) {
    throw new Error("board.create produced no board");
  }
  return boardId;
}

describe("WorktreeManager", () => {
  test("worktreePath lands under the container inside the repo", () => {
    const manager = new WorktreeManager();
    const path = manager.worktreePath("/repos/app", "board-1");

    expect(path).toBe(join("/repos/app", WORKTREE_CONTAINER, "board-1"));
  });

  test("a traversing board id is rejected rather than escaping the repo", () => {
    const manager = new WorktreeManager();

    expect(() => manager.worktreePath("/repos/app", "../../etc")).toThrow(
      SandboxEscapeError
    );
  });

  test("the first board for a repo does not need a worktree", () => {
    const manager = new WorktreeManager();

    expect(manager.needsWorktree([], "/repos/app")).toBe(false);
  });

  test("a second board for the same repo does need one", () => {
    const manager = new WorktreeManager();
    const boards = [{ repo: { directory: "/repos/app" } }];

    expect(manager.needsWorktree(boards, "/repos/app")).toBe(true);
    // A different repo is unaffected.
    expect(manager.needsWorktree(boards, "/repos/other")).toBe(false);
  });

  test("two boards on one repo get two isolated checkouts", async () => {
    const repo = makeRepo("chorus-wt-two-");
    const manager = new WorktreeManager();
    const store = new WorkspaceStore(
      mkdtempSync(join(tmpdir(), "chorus-wt-db-")),
      {
        worktreeProvisioner: manager,
      }
    );
    await store.load();

    const first = await seedBoard(store, repo);
    const second = await seedBoard(store, repo);

    const boards = store.getSnapshot().boards;
    expect(boards[0]?.repo.worktree).toBe(repo);
    expect(boards[1]?.repo.worktree).not.toBe(repo);
    expect(boards[1]?.repo.worktree).toBe(
      join(repo, WORKTREE_CONTAINER, second ?? "")
    );

    const listed = worktreeList(repo);
    expect(listed).toContain(repo);
    expect(listed).toContain(join(repo, WORKTREE_CONTAINER, second ?? ""));
    expect(first).toBeDefined();

    await store.close();
    rmSync(repo, { force: true, recursive: true });
  });

  test("removing a board removes its worktree but never the primary checkout", async () => {
    const repo = makeRepo("chorus-wt-remove-");
    const manager = new WorktreeManager();
    const store = new WorkspaceStore(
      mkdtempSync(join(tmpdir(), "chorus-wt-db-")),
      { worktreeProvisioner: manager }
    );
    await store.load();

    // The first board keeps the primary checkout; the second gets a worktree,
    // which is the one removal has to clean up.
    await seedBoard(store, repo);
    const second = await seedBoard(store, repo);
    const secondPath = store.getBoard(second)?.repo.worktree;
    if (!secondPath) {
      throw new Error("second board has no worktree");
    }
    expect(existsSync(secondPath)).toBe(true);

    await store.applyMutation({
      baseRevision: null,
      clientId: "worktree-test",
      mutationId: `remove-${crypto.randomUUID()}`,
      payload: { boardId: second },
      type: "board.remove",
    });

    // The worktree is gone with the board, rather than lingering until the next
    // boot's prune.
    expect(worktreeList(repo)).not.toContain(resolve(secondPath));
    // The repo itself survives — a board on the primary must never remove it.
    expect(existsSync(join(repo, "README.md"))).toBe(true);
    expect(worktreeList(repo)).toContain(resolve(repo));

    await store.close();
    rmSync(repo, { force: true, recursive: true });
  });

  test("ensureWorktree is idempotent", async () => {
    const repo = makeRepo("chorus-wt-idem-");
    const manager = new WorktreeManager();

    const first = await manager.ensureWorktree(repo, "board-1");
    const second = await manager.ensureWorktree(repo, "board-1");

    expect(second).toBe(first);
    expect(existsSync(first)).toBe(true);

    // One registered worktree per board, not two.
    const containerEntries = worktreeList(repo).filter((path) =>
      path.includes(WORKTREE_CONTAINER)
    );
    expect(containerEntries).toHaveLength(1);

    rmSync(repo, { force: true, recursive: true });
  });

  test("ten simultaneous board-creates produce one worktree each", async () => {
    const repo = makeRepo("chorus-wt-race-");
    const manager = new WorktreeManager();
    const store = new WorkspaceStore(
      mkdtempSync(join(tmpdir(), "chorus-wt-db-")),
      {
        worktreeProvisioner: manager,
      }
    );
    await store.load();

    // Fired together on purpose: this is plan risk #6. Worktree creation is
    // awaited inside the store's serial queue, so these queue rather than race,
    // and each create sees the boards the previous ones added.
    await Promise.all(
      Array.from({ length: 10 }, async () => seedBoard(store, repo))
    );

    const boards = store.getSnapshot().boards;
    expect(boards).toHaveLength(10);

    const paths = boards.map((board) => board.repo.worktree);
    // Exactly one primary checkout; the rest each got their own path.
    expect(paths.filter((path) => path === repo)).toHaveLength(1);
    expect(new Set(paths).size).toBe(10);

    const containerEntries = worktreeList(repo).filter((path) =>
      path.includes(WORKTREE_CONTAINER)
    );
    expect(containerEntries).toHaveLength(9);
    // Every recorded path is one git actually registered.
    for (const path of containerEntries) {
      expect(existsSync(path)).toBe(true);
    }

    await store.close();
    rmSync(repo, { force: true, recursive: true });
  });

  test("a dangling worktree is pruned on boot and a live one is kept", async () => {
    const repo = makeRepo("chorus-wt-prune-");
    const manager = new WorktreeManager();

    const live = await manager.ensureWorktree(repo, "board-live");
    const orphan = await manager.ensureWorktree(repo, "board-orphan");
    expect(
      worktreeList(repo).filter((p) => p.includes(WORKTREE_CONTAINER))
    ).toHaveLength(2);

    const removed = await manager.pruneOrphans(repo, new Set(["board-live"]));

    expect(removed).toEqual([orphan]);
    const remaining = worktreeList(repo).filter((path) =>
      path.includes(WORKTREE_CONTAINER)
    );
    expect(remaining).toEqual([live]);

    rmSync(repo, { force: true, recursive: true });
  });

  test("pruning never touches the primary checkout", async () => {
    const repo = makeRepo("chorus-wt-prune2-");
    const manager = new WorktreeManager();
    await manager.ensureWorktree(repo, "board-orphan");

    await manager.pruneOrphans(repo, new Set());

    expect(existsSync(repo)).toBe(true);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
    expect(worktreeList(repo)).toEqual([resolve(repo)]);

    rmSync(repo, { force: true, recursive: true });
  });

  test("a non-repository is rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-wt-nogit-"));
    const manager = new WorktreeManager();

    await expect(manager.ensureWorktree(dir, "board-1")).rejects.toThrow(
      NOT_A_REPO
    );

    rmSync(dir, { force: true, recursive: true });
  });
});

describe("WorktreeProvisioner contract", () => {
  test("a store with no provisioner leaves every board on the primary checkout", async () => {
    const repo = makeRepo("chorus-wt-none-");
    const store = new WorkspaceStore(
      mkdtempSync(join(tmpdir(), "chorus-wt-db-"))
    );
    await store.load();

    await seedBoard(store, repo);
    await seedBoard(store, repo);

    const paths = store
      .getSnapshot()
      .boards.map((board) => board.repo.worktree);
    expect(paths).toEqual([repo, repo]);

    await store.close();
    rmSync(repo, { force: true, recursive: true });
  });

  test("WorktreeManager satisfies the store's structural contract", () => {
    // Compile-time proof the two agree; the runtime assertion is the guard
    // against someone changing one signature and not the other.
    const provisioner: WorktreeProvisioner = new WorktreeManager();
    expect(typeof provisioner.needsWorktree).toBe("function");
    expect(typeof provisioner.ensureWorktree).toBe("function");
  });
});
