import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOTS_META_KEY = "repository-roots:v1";
const GIT_TIMEOUT_MS = 10_000;

export class RepositoryRegistryError extends Error {
  readonly code:
    | "invalid_repository_roots"
    | "invalid_repository_root"
    | "unregistered_repository_root";

  constructor(code: RepositoryRegistryError["code"], message: string) {
    super(message);
    this.name = "RepositoryRegistryError";
    this.code = code;
  }
}

export interface RepositoryRootMeta {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** Operator-approved checkout roots, independent of workspace board records. */
export class RepositoryRegistry {
  readonly #roots = new Set<string>();

  static async fromEnvironment(
    raw: string | undefined
  ): Promise<RepositoryRegistry> {
    const registry = new RepositoryRegistry();
    if (raw === undefined || raw.trim() === "") {
      return registry;
    }

    let values: unknown;
    try {
      values = JSON.parse(raw);
    } catch {
      throw new RepositoryRegistryError(
        "invalid_repository_roots",
        "CHORUS_REPOSITORY_ROOTS must be a JSON array of absolute Git checkout paths"
      );
    }

    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string")
    ) {
      throw new RepositoryRegistryError(
        "invalid_repository_roots",
        "CHORUS_REPOSITORY_ROOTS must be a JSON array of absolute Git checkout paths"
      );
    }

    for (const value of values) {
      if (!isAbsolute(value)) {
        throw new RepositoryRegistryError(
          "invalid_repository_roots",
          "CHORUS_REPOSITORY_ROOTS entries must be absolute paths"
        );
      }
      registry.#roots.add(await validateGitRoot(value));
    }
    return registry;
  }

  get roots(): string[] {
    return [...this.#roots].sort();
  }

  async validateCandidate(candidate: string): Promise<string> {
    const canonical = await validateGitRoot(candidate);
    if (!this.#roots.has(canonical)) {
      throw new RepositoryRegistryError(
        "unregistered_repository_root",
        `repository is not approved by the operator: ${canonical}`
      );
    }
    return canonical;
  }

  /**
   * Accepts an approved root or an exact Git-registered worktree beneath it.
   * Directory-taking engine commands must not turn an authenticated request
   * into access to arbitrary host paths.
   */
  async validateAuthorizedCheckout(candidate: string): Promise<string> {
    if (!isAbsolute(candidate)) {
      throw new RepositoryRegistryError(
        "invalid_repository_root",
        "repository checkout path must be absolute"
      );
    }

    let canonical: string;
    let root: string;
    let worktreeOutput: string;
    try {
      canonical = await realpath(resolve(candidate));
      const [topLevelResult, commonDirectoryResult, worktreeResult] =
        await Promise.all([
          execFileAsync("git", ["rev-parse", "--show-toplevel"], {
            cwd: canonical,
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
          }),
          execFileAsync(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            {
              cwd: canonical,
              timeout: GIT_TIMEOUT_MS,
              windowsHide: true,
            }
          ),
          execFileAsync("git", ["worktree", "list", "--porcelain"], {
            cwd: canonical,
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
          }),
        ]);
      if ((await realpath(topLevelResult.stdout.trim())) !== canonical) {
        throw new Error("directory is not a Git checkout root");
      }
      const commonDirectory = await realpath(
        resolve(canonical, commonDirectoryResult.stdout.trim())
      );
      root = await realpath(dirname(commonDirectory));
      worktreeOutput = worktreeResult.stdout;
    } catch {
      throw new RepositoryRegistryError(
        "invalid_repository_root",
        `directory is not an accessible Git checkout: ${candidate}`
      );
    }

    if (!this.#roots.has(root)) {
      throw new RepositoryRegistryError(
        "unregistered_repository_root",
        `repository is not approved by the operator: ${root}`
      );
    }

    if (canonical === root) {
      return canonical;
    }

    const segments = relative(root, canonical).split(sep);
    const isManagedWorktree =
      segments.length === 2 && segments[0] === ".chorus-worktrees";
    const isRegisteredWorktree = [
      ...worktreeOutput.matchAll(/^worktree (.+)$/gm),
    ].some((match) => {
      try {
        return resolve(match[1] ?? "") === canonical;
      } catch {
        return false;
      }
    });
    if (!(isManagedWorktree && isRegisteredWorktree)) {
      throw new RepositoryRegistryError(
        "unregistered_repository_root",
        `directory is not an approved repository root or managed worktree: ${canonical}`
      );
    }

    return canonical;
  }

  /** The caller must have obtained this path through the host folder picker. */
  validatePickedRoot(candidate: string): Promise<string> {
    return validateGitRoot(candidate);
  }

  addValidatedRoot(canonical: string): void {
    this.#roots.add(canonical);
  }

  async restorePersistedRoots(raw: string | null): Promise<string[]> {
    if (!raw) {
      return [];
    }
    let values: unknown;
    try {
      values = JSON.parse(raw);
    } catch {
      throw new RepositoryRegistryError(
        "invalid_repository_roots",
        "persisted repository registration is corrupt; repair or remove repository-roots:v1 in Chorus metadata"
      );
    }
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string")
    ) {
      throw new RepositoryRegistryError(
        "invalid_repository_roots",
        "persisted repository registration has an invalid shape"
      );
    }

    const restored: string[] = [];
    for (const value of values) {
      try {
        const canonical = await validateGitRoot(value);
        this.#roots.add(canonical);
        restored.push(canonical);
      } catch {
        // A moved or removed checkout is preserved as an inactive registration.
        // It cannot authorize a path until it again validates as a Git root.
      }
    }
    return restored;
  }

  static get persistedRootsKey(): string {
    return ROOTS_META_KEY;
  }
}

async function validateGitRoot(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new RepositoryRegistryError(
      "invalid_repository_root",
      "repository path must be absolute"
    );
  }

  let canonical: string;
  try {
    canonical = await realpath(resolve(candidate));
    const info = await stat(canonical);
    if (!info.isDirectory()) {
      throw new Error("path is not a directory");
    }
  } catch {
    throw new RepositoryRegistryError(
      "invalid_repository_root",
      `repository path does not exist or cannot be accessed: ${candidate}`
    );
  }

  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: canonical, timeout: GIT_TIMEOUT_MS, windowsHide: true }
    );
    const gitRoot = await realpath(result.stdout.trim());
    if (gitRoot !== canonical) {
      throw new Error("path is not the Git checkout root");
    }
  } catch {
    throw new RepositoryRegistryError(
      "invalid_repository_root",
      `directory is not an accessible Git checkout root: ${canonical}`
    );
  }
  return canonical;
}
