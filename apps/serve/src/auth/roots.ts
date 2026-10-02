import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Registered repository roots (spec §6.4, plan P4.6).
 *
 * `/snapshots/track`, `/snapshots/restore`, `/snapshots/diff`, and
 * `/git/status` all take a `directory` from the client and hand it to git as a
 * working directory. Before this phase nothing constrained it, so any caller
 * could point those routes at an arbitrary path on the host.
 *
 * A board's own binding is the unit of authority: `repo.directory` for a
 * primary checkout, `repo.worktree` for an isolated one. A request is allowed
 * when it resolves to one of those. There is deliberately no "is it under the
 * data dir?" fallback — the set is exactly what the workspace says it is.
 */

export class UnregisteredRootError extends Error {
  readonly candidate: string;

  constructor(candidate: string) {
    super(`directory is not a registered board repository: ${candidate}`);
    this.name = "UnregisteredRootError";
    this.candidate = candidate;
  }
}

/** The binding fields a board contributes to the allowed set. */
export interface RepoBinding {
  directory?: string | null | undefined;
  projectId?: string | null | undefined;
  worktree?: string | null | undefined;
}

export interface BoardLike {
  repo?: RepoBinding | null | undefined;
}

/**
 * Canonicalises a path for comparison.
 *
 * `realpathSync` resolves symlinks, which lexical containment cannot: a symlink
 * inside a registered repo pointing at `/etc` passes every `..` check and still
 * escapes. A path that does not exist yet cannot be resolved, so it falls back
 * to `resolve`, which is still correct for a root that is about to be created
 * (a worktree path).
 */
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

  // `projectId` is an opencode project identifier, not a filesystem path, so it
  // is intentionally not treated as a root here.
  return [repo.directory, repo.worktree].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

/**
 * Asserts `candidate` is one of the registered roots.
 *
 * Exact match against a canonicalised root, rather than containment: these
 * routes operate on a whole repository, so "somewhere inside a registered repo"
 * is not sufficient authority.
 */
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
