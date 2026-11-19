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
