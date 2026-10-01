import { type ExecFileOptions, execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@chorus/logger";
import { assertSafeGitRevision, resolveInside } from "../paths/sandbox";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "SNAPSHOT"
);

const MAX_BUFFER = 50 * 1024 * 1024;

const INSERTION_REGEX = /(\d+) insertion/;
const DELETION_REGEX = /(\d+) deletion/;

interface ExecFileResult {
  stderr: string;
  stdout: string;
}

/**
 * Argument-array process execution. Never pass an interpolated shell string
 * here — every git invocation in this module goes through this helper so
 * client-supplied paths and revisions cannot become shell syntax.
 */
function execFileText(
  file: string,
  args: string[],
  options: ExecFileOptions
): Promise<ExecFileResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      file,
      args,
      { ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stderr: String(stderr), stdout: String(stdout) });
      }
    );
  });
}

export interface SnapshotPatch {
  files: string[];
  hash: string;
}

export interface FileDiff {
  additions: number;
  after: string | null;
  before: string | null;
  deletions: number;
  file: string;
  status: "added" | "deleted" | "modified";
}

export interface GitStatus {
  ahead: number;
  behind: number;
  branch: string;
  linesAdded: number;
  linesRemoved: number;
  modified: number;
  staged: number;
  tracking: string | null;
  untracked: number;
}

export interface SnapshotResult {
  diff?: string;
  hash: string;
  patches?: SnapshotPatch[];
}

function getSnapshotDir(projectPath: string): string {
  const sanitizedName = projectPath.replace(/[^a-zA-Z0-9]/g, "_");
  return join(homedir(), ".chorus", "snapshots", sanitizedName);
}

function getGitDir(projectPath: string): string {
  return join(getSnapshotDir(projectPath), ".git");
}

async function ensureSnapshotRepo(projectPath: string): Promise<void> {
  const snapshotDir = getSnapshotDir(projectPath);
  const gitDir = getGitDir(projectPath);

  if (!existsSync(gitDir)) {
    mkdirSync(snapshotDir, { recursive: true });
    await execFileText("git", ["init", "--bare", gitDir], {
      cwd: snapshotDir,
    });

    const gitEnv = { ...process.env, GIT_DIR: gitDir };
    await execFileText("git", ["config", "core.autocrlf", "false"], {
      cwd: projectPath,
      env: gitEnv,
    });
    await execFileText("git", ["config", "core.longpaths", "true"], {
      cwd: projectPath,
      env: gitEnv,
    });

    const excludePath = join(gitDir, "info", "exclude");
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(
      excludePath,
      "*.log\nnode_modules/\ndist/\n.turbo/\n.git/\n.chorus/\n"
    );
  }
}

function runGit(projectPath: string, args: string[]): Promise<ExecFileResult> {
  const gitDir = getGitDir(projectPath);
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: projectPath };
  return execFileText("git", args, {
    cwd: projectPath,
    env,
    maxBuffer: MAX_BUFFER,
  });
}

function runRealGit(
  projectPath: string,
  args: string[]
): Promise<ExecFileResult> {
  return execFileText("git", args, {
    cwd: projectPath,
    maxBuffer: MAX_BUFFER,
  });
}

export async function track(projectPath: string): Promise<string> {
  await ensureSnapshotRepo(projectPath);

  await runGit(projectPath, ["add", "-A"]);

  const { stdout } = await runGit(projectPath, ["write-tree"]);
  return stdout.trim();
}

export async function restore(
  projectPath: string,
  hash: string
): Promise<void> {
  const safeHash = assertSafeGitRevision(hash);
  await ensureSnapshotRepo(projectPath);

  await runGit(projectPath, ["read-tree", safeHash]);
  await runGit(projectPath, ["checkout-index", "-a", "-f"]);
}

export async function revert(
  projectPath: string,
  patches: SnapshotPatch[]
): Promise<void> {
  await ensureSnapshotRepo(projectPath);

  for (const patch of patches) {
    const safeHash = assertSafeGitRevision(patch.hash);

    const filesToCheckout = patch.files.filter((file) => {
      try {
        return existsSync(resolveInside(projectPath, file));
      } catch {
        return false;
      }
    });

    if (filesToCheckout.length > 0) {
      await runGit(projectPath, [
        "checkout",
        safeHash,
        "--",
        ...filesToCheckout,
      ]);
    }

    for (const file of patch.files) {
      if (filesToCheckout.includes(file)) {
        continue;
      }
      await rm(resolveInside(projectPath, file), { force: true });
    }
  }
}

export async function getPatch(
  projectPath: string,
  fromHash: string
): Promise<SnapshotPatch> {
  const safeHash = assertSafeGitRevision(fromHash);
  await ensureSnapshotRepo(projectPath);

  const { stdout } = await runGit(projectPath, [
    "diff",
    "--cached",
    "--name-only",
    safeHash,
  ]);

  const files = stdout.split("\n").filter((f) => f.trim().length > 0);

  return { hash: safeHash, files };
}

export async function getDiff(
  projectPath: string,
  fromHash: string
): Promise<string> {
  const safeHash = assertSafeGitRevision(fromHash);
  await ensureSnapshotRepo(projectPath);

  const { stdout } = await runGit(projectPath, [
    "diff",
    "--cached",
    safeHash,
    "--stat",
  ]);

  return stdout;
}

export async function getFullDiff(
  projectPath: string,
  fromHash: string,
  toHash?: string
): Promise<FileDiff[]> {
  const safeFrom = assertSafeGitRevision(fromHash);
  const safeTo = toHash ? assertSafeGitRevision(toHash) : "HEAD";
  await ensureSnapshotRepo(projectPath);

  const { stdout } = await runGit(projectPath, [
    "diff",
    "--name-status",
    safeFrom,
    safeTo,
  ]);

  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);

  const diffs: FileDiff[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) {
      continue;
    }

    const statusCode = parts[0];
    const file = parts[1];

    let status: "added" | "deleted" | "modified";
    if (statusCode.startsWith("A")) {
      status = "added";
    } else if (statusCode.startsWith("D")) {
      status = "deleted";
    } else {
      status = "modified";
    }

    diffs.push({
      file,
      status,
      additions: 0,
      deletions: 0,
      before: null,
      after: null,
    });
  }

  return diffs;
}

function parseStatusShortOutput(output: string): {
  untracked: number;
  modified: number;
  staged: number;
} {
  let untracked = 0;
  let modified = 0;
  let staged = 0;

  const lines = output.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code === "??") {
      untracked++;
    } else if (code[0] !== " " && code[0] !== "?") {
      staged++;
    } else if (code[1] !== " ") {
      modified++;
    }
  }

  return { untracked, modified, staged };
}

function parseDiffStatOutput(output: string): {
  linesAdded: number;
  linesRemoved: number;
} {
  let linesAdded = 0;
  let linesRemoved = 0;

  const lines = output.split("\n");
  // @ts-expect-error Array.at() is ES2022 but supported in bun
  const statLine = lines.at(-1) || "";
  const insertMatch = statLine.match(INSERTION_REGEX);
  const deleteMatch = statLine.match(DELETION_REGEX);
  if (insertMatch) {
    linesAdded = Number.parseInt(insertMatch[1], 10);
  }
  if (deleteMatch) {
    linesRemoved = Number.parseInt(deleteMatch[1], 10);
  }

  return { linesAdded, linesRemoved };
}

export async function getGitStatus(projectPath: string): Promise<GitStatus> {
  const [branchOutput, trackingOutput, statusOutput, diffStatOutput] =
    await Promise.allSettled([
      runRealGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runRealGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"]),
      runRealGit(projectPath, ["status", "-s"]),
      runRealGit(projectPath, ["diff", "--stat"]),
    ]);

  const branch =
    branchOutput.status === "fulfilled" ? branchOutput.value.stdout.trim() : "";

  const tracking =
    trackingOutput.status === "fulfilled"
      ? trackingOutput.value.stdout.trim() || null
      : null;

  const statusCounts =
    statusOutput.status === "fulfilled"
      ? parseStatusShortOutput(statusOutput.value.stdout)
      : { untracked: 0, modified: 0, staged: 0 };

  const diffCounts =
    diffStatOutput.status === "fulfilled"
      ? parseDiffStatOutput(diffStatOutput.value.stdout)
      : { linesAdded: 0, linesRemoved: 0 };

  let ahead = 0;
  let behind = 0;

  if (tracking) {
    const revListOutput = await runRealGit(projectPath, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${tracking}`,
    ]);
    const parts = revListOutput.stdout.trim().split("\t");
    ahead = Number.parseInt(parts[0], 10) || 0;
    behind = Number.parseInt(parts[1], 10) || 0;
  }

  return {
    branch,
    tracking,
    ahead,
    behind,
    untracked: statusCounts.untracked,
    modified: statusCounts.modified,
    staged: statusCounts.staged,
    linesAdded: diffCounts.linesAdded,
    linesRemoved: diffCounts.linesRemoved,
  };
}

export async function cleanup(projectPath: string): Promise<void> {
  try {
    await runGit(projectPath, ["gc", "--prune=7.days"]);
  } catch (error) {
    logger.warn("snapshot-cleanup-failed", { error, projectPath });
  }
}
