import { runRealGit } from "./repository";
import type { GitStatus } from "./types";

const INSERTION_REGEX = /(\d+) insertion/;
const DELETION_REGEX = /(\d+) deletion/;

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
  const statLine = lines.at(-1) ?? "";
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
