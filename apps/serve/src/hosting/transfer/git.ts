import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  MAX_REPOSITORY_FILES,
  portableRepositoryPathSchema,
} from "@chorus/contracts";

const INDEX_LINE = /^(100644|100755) ([a-f0-9]+) 0\t(.+)$/s;

export class RepositoryTransferError extends Error {
  readonly code:
    | "repository_not_ready"
    | "repository_changed"
    | "checkpoint_invalid"
    | "checkpoint_too_large"
    | "target_incompatible"
    | "destination_exists";
  constructor(code: RepositoryTransferError["code"]) {
    super(code);
    this.name = "RepositoryTransferError";
    this.code = code;
  }
}

export async function readGitIndex(directory: string, importing = false) {
  const raw = await gitText(directory, ["ls-files", "--stage", "-z"], {
    importing,
  });
  const modes = new Map<string, "100644" | "100755">();
  for (const line of raw.split("\0").filter(Boolean)) {
    const match = INDEX_LINE.exec(line);
    if (
      !(
        match?.[1] &&
        match[3] &&
        portableRepositoryPathSchema.safeParse(match[3]).success
      )
    ) {
      throw new RepositoryTransferError(
        importing ? "checkpoint_invalid" : "repository_not_ready"
      );
    }
    modes.set(match[3], match[1] === "100755" ? "100755" : "100644");
  }
  if (modes.size > MAX_REPOSITORY_FILES) {
    throw new RepositoryTransferError("checkpoint_too_large");
  }
  return modes;
}

/** No shell, prompts, hooks, filesystem monitor or external diff execution. */
export function transferGit(
  directory: string,
  args: string[],
  options: {
    importing?: boolean;
    input?: string | Uint8Array;
    allowFailure?: boolean;
    maxBytes?: number;
  } = {}
): Promise<{ bytes: Buffer; code: number }> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
  );
  Object.assign(environment, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  });
  if (options.importing) {
    Object.assign(environment, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    });
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.protectNTFS=true",
        "-c",
        "core.protectHFS=true",
        "-c",
        `core.hooksPath=${join(directory, ".git", "chorus-disabled-hooks")}`,
        "-c",
        "core.fsync=all",
        ...args,
      ],
      {
        cwd: directory,
        env: environment,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: options.maxBytes ?? 8 * 1024 * 1024,
        encoding: "buffer",
      },
      (error, stdout) => {
        let code = 0;
        if (error) {
          code = typeof error.code === "number" ? error.code : -1;
        }
        if (error && !(options.allowFailure && code === 1)) {
          reject(
            new RepositoryTransferError(
              options.importing ? "checkpoint_invalid" : "repository_not_ready"
            )
          );
          return;
        }
        resolve({ bytes: stdout, code });
      }
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

export async function gitText(
  directory: string,
  args: string[],
  options?: Parameters<typeof transferGit>[2]
): Promise<string> {
  const result = await transferGit(directory, args, options);
  return new TextDecoder("utf-8", { fatal: true })
    .decode(result.bytes)
    .trimEnd();
}
