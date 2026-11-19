import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { assertSafeGitRevision, resolveInside } from "../paths/sandbox";
import { ensureSnapshotRepo, runGit } from "./repository";
import type { FileDiff, SnapshotPatch } from "./types";

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
