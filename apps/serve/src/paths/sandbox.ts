import { isAbsolute, relative, resolve, sep } from "node:path";

export class SandboxEscapeError extends Error {
  readonly root: string;
  readonly candidate: string;

  constructor(root: string, candidate: string) {
    super(`path "${candidate}" escapes sandbox root "${root}"`);
    this.name = "SandboxEscapeError";
    this.root = root;
    this.candidate = candidate;
  }
}

export class InvalidPathError extends Error {
  readonly candidate: string;

  constructor(candidate: string) {
    super(`invalid path: ${JSON.stringify(candidate)}`);
    this.name = "InvalidPathError";
    this.candidate = candidate;
  }
}

/**
 * Resolves `candidate` against `root` and rejects anything that escapes it.
 *
 * - Relative candidates resolve under `root`.
 * - Absolute candidates must already live inside `root`.
 * - Rejects NUL bytes and paths that traverse above `root` (including
 *   prefix-sibling cases such as `/data2` against `/data`).
 *
 * This is lexical containment. Symlink resolution is layered on in the
 * security phase; callers that touch the filesystem must still guard roots.
 */
export function resolveInside(root: string, candidate: string): string {
  if (candidate.length === 0) {
    throw new InvalidPathError(candidate);
  }

  if (candidate.includes("\0")) {
    throw new InvalidPathError(candidate);
  }

  const resolvedRoot = resolve(root);
  const resolved = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedRoot, candidate);

  const rel = relative(resolvedRoot, resolved);

  if (rel === "") {
    return resolved;
  }

  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SandboxEscapeError(resolvedRoot, candidate);
  }

  return resolved;
}

export function isInside(root: string, candidate: string): boolean {
  try {
    resolveInside(root, candidate);
    return true;
  } catch {
    return false;
  }
}

const GIT_REVISION_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z._/@{}^~-]*$/;
const WHITESPACE_PATTERN = /\s/;

/**
 * Validates a client-supplied git revision before it reaches an argument array.
 *
 * `execFile` already removes the shell-injection class, but a leading `-` or a
 * range/whitespace sequence could still be interpreted as a git option or
 * revision range. Reject those explicitly.
 */
export function assertSafeGitRevision(value: string): string {
  if (value.length === 0 || value.length > 512) {
    throw new InvalidPathError(value);
  }

  if (
    value.startsWith("-") ||
    value.includes("..") ||
    WHITESPACE_PATTERN.test(value)
  ) {
    throw new InvalidPathError(value);
  }

  if (!GIT_REVISION_PATTERN.test(value)) {
    throw new InvalidPathError(value);
  }

  return value;
}
