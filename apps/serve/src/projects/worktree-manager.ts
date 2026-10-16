import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@chorus/logger";
import { resolveInside, SandboxEscapeError } from "../paths/sandbox";

const execFileAsync = promisify(execFile);

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "SERVE:PROJECTS"
);

/** Container-relative directory holding per-board worktrees. */
export const WORKTREE_CONTAINER = ".chorus-worktrees";

export class WorktreeNotCleanError extends Error {
  readonly boardId: string;

  constructor(boardId: string) {
    super(
      `worktree for board ${boardId} contains uncommitted, untracked, or ignored files; it was preserved`
    );
    this.name = "WorktreeNotCleanError";
    this.boardId = boardId;
  }
}

/**
 * Worktree-per-board (spec §2 rule 1, plan P6 task 2).
 *
 * The first board for a repo uses the primary checkout. Every *additional*
 * concurrent board for the same repo gets its own git worktree under
 * `<repo>/.chorus-worktrees/<boardId>`, so two agents editing one repository
 * cannot collide on the index or on files.
 *
 * Every git invocation goes through `execFile` with an argument array. There is
 * no shell here, and none of these values is ever interpolated into a command
 * string — plan risk #8 is the regression test for exactly this.
 *
 * That audit is a grep rather than an AST walk, so it reads comments too and
 * will flag prose that quotes the shell form it forbids. Reword the comment
 * rather than loosening the pattern.
 */
export class WorktreeManager {
  readonly #gitTimeoutMs: number;

  constructor(options: { gitTimeoutMs?: number } = {}) {
    this.#gitTimeoutMs = options.gitTimeoutMs ?? 30_000;
  }

  /**
   * Where a board's worktree belongs.
   *
   * `boardId` is server-minted, but it still goes through `resolveInside` rather
   * than straight into `join`: containment is cheap and this is the one place a
   * traversal bug would hand a caller a path outside the repo.
   */
  worktreePath(repoDirectory: string, boardId: string): string {
    const root = resolve(repoDirectory);
    return resolveInside(root, join(WORKTREE_CONTAINER, boardId));
  }

  /** True when another live board already holds this repo's primary checkout. */
  needsWorktree(
    boards: ReadonlyArray<{ repo: { directory: string } }>,
    repoDirectory: string
  ): boolean {
    const target = canonicalSync(repoDirectory);
    return boards.some(
      (board) => canonicalSync(board.repo.directory) === target
    );
  }

  /**
   * Creates the worktree, or returns the existing one.
   *
   * Idempotent by asking git rather than by checking the filesystem: a directory
   * can exist without being a registered worktree, and re-adding a registered
   * path fails. Two boards racing for the same repo is the case plan risk #6 is
   * about, so the caller must await this inside the store's serial queue.
   */
  async ensureWorktree(
    repoDirectory: string,
    boardId: string,
    branch?: string
  ): Promise<string> {
    // Canonical root, so paths we build line up with the ones git reports.
    //
    // `git worktree list --porcelain` returns realpaths, while `resolve` is
    // lexical. On a symlinked root — macOS `/var` → `/private/var`, or a
    // symlinked projects folder — the two disagree, so the registered check
    // misses a worktree that exists and `add` then fails on a path already in use.
    const repoRoot = await canonical(repoDirectory);
    const path = this.worktreePath(repoRoot, boardId);

    assertRealRepo(repoRoot);
    await assertContained(repoRoot, path);

    const registered = await this.#listWorktreePaths(repoRoot);
    if (registered.has(path)) {
      logger.info("worktree-already-present", { boardId, path });
      return path;
    }

    await mkdir(dirname(path), { recursive: true });
    await assertContained(repoRoot, path);

    const args = ["worktree", "add", "--quiet"];
    if (branch) {
      // A new worktree cannot check out a branch another worktree already holds,
      // so a named branch becomes a detached head at that revision.
      args.push("--detach");
    }
    args.push(path, branch ?? "HEAD");

    logger.info("worktree-creating", { boardId, path, repoRoot });
    await this.#git(repoRoot, args);

    // A worktree path is handed to the engine as its working directory and can
    // come back to us through a client, so confirm its real path after creation.
    await assertContained(repoRoot, path);

    logger.info("worktree-created", { boardId, path });
    return path;
  }

  async removeWorktree(repoDirectory: string, boardId: string): Promise<void> {
    const repoRoot = await canonical(repoDirectory);
    const path = this.worktreePath(repoRoot, boardId);

    await assertContained(repoRoot, path);
    const registered = await this.#listWorktreePaths(repoRoot);
    if (!registered.has(path)) {
      if (existsSync(path)) {
        throw new Error(
          `refusing to remove unregistered worktree path for board ${boardId}`
        );
      }
      return;
    }

    await this.#assertClean(path, boardId);

    // Git performs its own clean-worktree check here. Keep it as a second guard
    // against edits arriving after the status probe; never use --force because
    // that also removes ignored and untracked user files.
    await this.#git(repoRoot, ["worktree", "remove", path]);
    logger.info("worktree-removed", { boardId, path });
  }

  async assertRemovable(repoDirectory: string, boardId: string): Promise<void> {
    const repoRoot = await canonical(repoDirectory);
    const path = this.worktreePath(repoRoot, boardId);

    await assertContained(repoRoot, path);
    if (!(await this.#listWorktreePaths(repoRoot)).has(path)) {
      if (existsSync(path)) {
        throw new Error(
          `refusing to remove unregistered worktree path for board ${boardId}`
        );
      }
      return;
    }
    await this.#assertClean(path, boardId);
  }

  async #assertClean(path: string, boardId: string): Promise<void> {
    const status = await this.#git(path, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    if (status.trim().length > 0) {
      throw new WorktreeNotCleanError(boardId);
    }
  }

  /**
   * Removes worktree directories that no live board claims.
   *
   * A crashed serve leaves directories behind that git still has registered, and
   * the next boot would otherwise inherit them: `git worktree list` grows without
   * bound and a new board can collide with a stale checkout. Only ever removes
   * entries under our own container directory and only ones whose name is not a
   * live board id, so a bug here cannot delete a user's checkout.
   */
  async pruneOrphans(
    repoDirectory: string,
    liveBoardIds: ReadonlySet<string>
  ): Promise<string[]> {
    // Canonical for the same reason as `ensureWorktree`: the entries come from
    // git as realpaths, so a lexical container never matches and no orphan is
    // ever pruned on a symlinked root.
    const repoRoot = await canonical(repoDirectory);
    const container = resolveInside(repoRoot, WORKTREE_CONTAINER);

    if (!existsSync(container)) {
      return [];
    }

    const removed: string[] = [];

    for (const entry of await this.#worktreeEntries(repoRoot)) {
      const name = basename(entry.path);

      // Anything not ours is left alone, whatever it is named.
      if (dirname(entry.path) !== container || name.length === 0) {
        continue;
      }

      if (liveBoardIds.has(name)) {
        continue;
      }

      const boardId = name;
      try {
        await this.removeWorktree(repoRoot, boardId);
        logger.info("worktree-orphan-removed", { boardId });
        removed.push(entry.path);
      } catch (error) {
        if (!(error instanceof WorktreeNotCleanError)) {
          throw error;
        }

        logger.warn("worktree-orphan-preserved-dirty", { boardId });
      }
    }

    return removed;
  }

  async #git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: this.#gitTimeoutMs,
      });
      return stdout;
    } catch (error) {
      const stderr =
        error instanceof Error && "stderr" in error
          ? String((error as { stderr?: unknown }).stderr ?? "")
          : "";
      throw new Error(
        `git ${args[0] ?? ""} ${args[1] ?? ""} failed: ${
          error instanceof Error ? error.message : String(error)
        }${stderr ? ` (${stderr.trim()})` : ""}`
      );
    }
  }

  /** Absolute paths git currently has registered for this repository. */
  async #listWorktreePaths(repoRoot: string): Promise<Set<string>> {
    const out = await this.#git(repoRoot, ["worktree", "list", "--porcelain"]);
    const paths = new Set<string>();

    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.add(resolve(line.slice("worktree ".length)));
      }
    }

    return paths;
  }

  /** Registered worktrees that live inside our container directory. */
  async #worktreeEntries(repoRoot: string): Promise<{ path: string }[]> {
    const out = await this.#git(repoRoot, ["worktree", "list", "--porcelain"]);
    const entries: { path: string }[] = [];

    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        entries.push({ path: resolve(line.slice("worktree ".length)) });
      }
    }

    return entries;
  }
}

/**
 * Confirms a path really is inside the repo once symlinks are resolved.
 *
 * `resolveInside` is lexical (paths/sandbox.ts), so a symlink planted inside the
 * container could otherwise point a worktree at `/etc`. The worktree may not
 * exist yet when this runs for a freshly added one, hence the resolve fallback.
 */
/**
 * A path with symlinks resolved, falling back to the lexical form.
 *
 * The fallback covers a path that does not exist yet, which is the normal case for
 * a worktree about to be created.
 */
async function canonical(path: string): Promise<string> {
  return await realpath(path).catch(() => resolve(path));
}

function canonicalSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function assertContained(root: string, candidate: string): Promise<void> {
  const realRoot = await realpath(root);
  const realCandidate = await realPathWithMissingSuffix(candidate);
  const relativePath = relative(realRoot, realCandidate);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new SandboxEscapeError(realRoot, candidate);
  }
}

async function realPathWithMissingSuffix(candidate: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(candidate);

  while (true) {
    try {
      await lstat(current);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }

      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.push(basename(current));
      current = parent;
      continue;
    }

    // Resolving an existing symlink here catches a managed container redirected
    // outside the repository before mkdir or git can touch its target.
    const resolved = await realpath(current);
    return resolve(resolved, ...missing.reverse());
  }
}

function assertRealRepo(repoRoot: string): void {
  if (!existsSync(join(repoRoot, ".git"))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
}
