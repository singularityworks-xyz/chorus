import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export class UnregisteredRootError extends Error {
  readonly candidate: string;

  constructor(candidate: string) {
    super(`directory is not a registered board repository: ${candidate}`);
    this.name = "UnregisteredRootError";
    this.candidate = candidate;
  }
}

export interface RepoBinding {
  directory?: string | null | undefined;
  projectId?: string | null | undefined;
  worktree?: string | null | undefined;
}

export interface BoardLike {
  repo?: RepoBinding | null | undefined;
}

function canonical(candidate: string): string {
  const absolute = resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function repoRoots(board: BoardLike): string[] {
  const repo = board.repo;
  if (!repo) {
    return [];
  }

  return [repo.directory, repo.worktree].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

export function assertRegisteredRoot(
  candidate: string,
  boards: readonly BoardLike[]
): string {
  const target = canonical(candidate);

  for (const board of boards) {
    for (const root of repoRoots(board)) {
      if (canonical(root) === target) {
        return target;
      }
    }
  }

  throw new UnregisteredRootError(candidate);
}

export function isRegisteredRoot(
  candidate: string,
  boards: readonly BoardLike[]
): boolean {
  try {
    assertRegisteredRoot(candidate, boards);
    return true;
  } catch {
    return false;
  }
}
