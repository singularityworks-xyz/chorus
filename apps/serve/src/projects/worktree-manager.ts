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

export class WorktreeManager {
  readonly #gitTimeoutMs: number;

  constructor(options: { gitTimeoutMs?: number } = {}) {
    this.#gitTimeoutMs = options.gitTimeoutMs ?? 30_000;
  }

  worktreePath(repoDirectory: string, boardId: string): string {
    const root = resolve(repoDirectory);
    return resolveInside(root, join(WORKTREE_CONTAINER, boardId));
  }

  needsWorktree(
    boards: ReadonlyArray<{ repo: { directory: string } }>,
    repoDirectory: string
  ): boolean {
    const target = canonicalSync(repoDirectory);
    return boards.some(
      (board) => canonicalSync(board.repo.directory) === target
    );
  }

  async ensureWorktree(
    repoDirectory: string,
    boardId: string,
    branch?: string
  ): Promise<string> {
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
      args.push("--detach");
    }
    args.push(path, branch ?? "HEAD");

    logger.info("worktree-creating", { boardId, path, repoRoot });
    await this.#git(repoRoot, args);

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

  async pruneOrphans(
    repoDirectory: string,
    liveBoardIds: ReadonlySet<string>
  ): Promise<string[]> {
    const repoRoot = await canonical(repoDirectory);
    const container = resolveInside(repoRoot, WORKTREE_CONTAINER);

    if (!existsSync(container)) {
      return [];
    }

    const removed: string[] = [];

    for (const entry of await this.#worktreeEntries(repoRoot)) {
      const name = basename(entry.path);

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

    const resolved = await realpath(current);
    return resolve(resolved, ...missing.reverse());
  }
}

function assertRealRepo(repoRoot: string): void {
  if (!existsSync(join(repoRoot, ".git"))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
}
