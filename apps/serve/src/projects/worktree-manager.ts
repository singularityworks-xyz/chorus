import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
    const target = resolve(repoDirectory);
    return boards.some((board) => resolve(board.repo.directory) === target);
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

    const registered = await this.#listWorktreePaths(repoRoot);
    if (registered.has(path)) {
      logger.info("worktree-already-present", { boardId, path });
      return path;
    }

    await mkdir(dirname(path), { recursive: true });

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
    // come back to us through a client, so confirm the real path is still inside
    // the repo once symlinks are resolved. `resolveInside` is lexical only.
    await assertContained(repoRoot, path);

    logger.info("worktree-created", { boardId, path });
    return path;
  }

  async removeWorktree(repoDirectory: string, boardId: string): Promise<void> {
    const repoRoot = await canonical(repoDirectory);
    const path = this.worktreePath(repoRoot, boardId);

    await assertContained(repoRoot, path);
    await this.#git(repoRoot, ["worktree", "remove", "--force", path]);
    logger.info("worktree-removed", { boardId, path });
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

      await this.#git(repoRoot, ["worktree", "remove", "--force", entry.path]);
      logger.info("worktree-orphan-removed", { path: entry.path });
      removed.push(entry.path);
    }

    return removed;
  }

  async #git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
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

async function assertContained(root: string, candidate: string): Promise<void> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  const realCandidate = await realpath(candidate).catch(() =>
    resolve(candidate)
  );

  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}/`)) {
    throw new SandboxEscapeError(realRoot, candidate);
  }
}

function assertRealRepo(repoRoot: string): void {
  if (!existsSync(join(repoRoot, ".git"))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
}
