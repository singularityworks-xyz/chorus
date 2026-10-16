import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_REPOSITORY_FILE_BYTES,
  MAX_REPOSITORY_FILES,
  portableRepositoryPathSchema,
  type RepositoryCheckpoint,
} from "@chorus/contracts";
import { isInside } from "../../paths/sandbox";
import type { RepositoryContent } from "./content";
import { RepositoryTransferError } from "./git";

const EXECUTABLE_BITS = 0o111;

async function readWorkingFile(root: string, path: string) {
  portableRepositoryPathSchema.parse(path);
  const filename = join(root, path);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(filename);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !isInside(root, await realpath(filename))
  ) {
    throw new RepositoryTransferError("repository_not_ready");
  }
  if (before.size > MAX_REPOSITORY_FILE_BYTES) {
    throw new RepositoryTransferError("checkpoint_too_large");
  }
  const file = await open(filename, "r");
  try {
    const current = await file.stat();
    if (
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== before.size
    ) {
      throw new RepositoryTransferError("repository_changed");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (!result.bytesRead) {
        throw new RepositoryTransferError("repository_changed");
      }
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new RepositoryTransferError("repository_changed");
    }
    return { bytes, mode: before.mode };
  } finally {
    await file.close();
  }
}

export function isControlPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) =>
      [".chorus", ".chorus-worktrees"].includes(segment.toLowerCase())
    );
}

export async function captureFiles(
  root: string,
  modes: Map<string, "100644" | "100755">,
  paths: string[],
  content: RepositoryContent,
  remaining: number
) {
  const files: RepositoryCheckpoint["files"] = [];
  let total = 0;
  for (const path of new Set(paths)) {
    if (isControlPath(path)) {
      continue;
    }
    const file = await readWorkingFile(root, path);
    if (!file) {
      continue;
    }
    total += file.bytes.length;
    if (total > remaining || files.length >= MAX_REPOSITORY_FILES) {
      throw new RepositoryTransferError("checkpoint_too_large");
    }
    // Windows Git tracks executable mode in its index; POSIX also captures an
    // unstaged chmod without depending on the destination's platform defaults.
    files.push({
      path,
      mode: workingFileMode(file.mode, modes.get(path)),
      content: await content.put(file.bytes),
    });
  }
  return files;
}

function workingFileMode(
  mode: number,
  indexedMode?: string
): "100644" | "100755" {
  if (process.platform === "win32") {
    return indexedMode === "100755" ? "100755" : "100644";
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: portable executable bits
  const executable = (mode & EXECUTABLE_BITS) !== 0;
  return executable ? "100755" : "100644";
}

export async function verifyWorkingFiles(
  root: string,
  modes: Map<string, string>,
  files: RepositoryCheckpoint["files"],
  paths: string[]
): Promise<void> {
  const expected = new Map(files.map((file) => [file.path, file]));
  for (const path of new Set(paths)) {
    if (isControlPath(path)) {
      continue;
    }
    const current = await readWorkingFile(root, path);
    const file = expected.get(path);
    if (!file) {
      if (current) {
        throw new RepositoryTransferError("repository_changed");
      }
      continue;
    }
    if (
      !current ||
      createHash("sha256").update(current.bytes).digest("hex") !==
        file.content.digest ||
      workingFileMode(current.mode, modes.get(file.path)) !== file.mode
    ) {
      throw new RepositoryTransferError("repository_changed");
    }
  }
}
