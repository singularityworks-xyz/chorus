import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  MAX_REPOSITORY_FILES,
  portableRepositoryPathSchema,
  type RepositoryCheckpoint,
  sha256Schema,
} from "@chorus/contracts";
import { ensurePrivateHostDirectory } from "../private-directory";
import { RepositoryContent } from "./content";
import { syncDirectory } from "./durability";
import {
  gitText,
  RepositoryTransferError,
  readGitIndex,
  transferGit,
} from "./git";

/** Verifies every payload before creating a new private, inactive checkout. */
export async function stageRepository(
  checkpointDirectory: string,
  expectedDigest: string,
  stagingParent: string
): Promise<string> {
  sha256Schema.parse(expectedDigest);
  const content = await RepositoryContent.open(checkpointDirectory);
  const { checkpoint, digest } = await content.manifest();
  if (digest !== expectedDigest) {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
  const verified = new Map<string, string>();
  for (const reference of [
    checkpoint.staged,
    ...(checkpoint.history ? [checkpoint.history] : []),
    ...checkpoint.files.map((file) => file.content),
  ]) {
    if (!verified.has(reference.digest)) {
      verified.set(reference.digest, await content.path(reference));
    }
  }
  const parent = await ensurePrivateHostDirectory(stagingParent);
  const directory = await mkdtemp(join(parent, "repository-"));
  try {
    await restoreGitState(directory, checkpoint, content);
    const index = await readGitIndex(directory, true);
    if (
      process.platform === "win32" &&
      checkpoint.files.some(
        (file) => file.mode !== (index.get(file.path) ?? "100644")
      )
    ) {
      throw new RepositoryTransferError("target_incompatible");
    }
    await restoreWorkingFiles(directory, checkpoint, content);
    await syncDirectory(join(directory, ".git"));
    await syncDirectory(directory);
    await syncDirectory(parent);
    return directory;
  } catch (error) {
    const resolved = resolve(directory);
    if (resolved.startsWith(`${resolve(parent)}${sep}`)) {
      await rm(resolved, { recursive: true, force: true });
    }
    throw error;
  }
}

async function restoreGitState(
  directory: string,
  checkpoint: RepositoryCheckpoint,
  content: RepositoryContent
): Promise<void> {
  await transferGit(
    directory,
    [
      "init",
      "--quiet",
      "--template=",
      `--object-format=${checkpoint.objectFormat}`,
    ],
    { importing: true }
  );
  await transferGit(directory, ["config", "core.autocrlf", "false"], {
    importing: true,
  });
  if (process.platform === "win32") {
    await transferGit(directory, ["config", "core.longpaths", "true"], {
      importing: true,
    });
  }
  if (checkpoint.history) {
    const history = await content.path(checkpoint.history);
    await transferGit(directory, ["bundle", "verify", history], {
      importing: true,
    });
    await transferGit(directory, ["bundle", "unbundle", history], {
      importing: true,
    });
    await transferGit(directory, ["fsck", "--full", "--strict"], {
      importing: true,
    });
  }
  if (checkpoint.refs.length) {
    await transferGit(directory, ["update-ref", "--stdin"], {
      importing: true,
      input: checkpoint.refs
        .map((ref) => `update ${ref.name} ${ref.oid}\n`)
        .join(""),
    });
  }
  if (checkpoint.branch) {
    await transferGit(directory, ["symbolic-ref", "HEAD", checkpoint.branch], {
      importing: true,
    });
  } else if (checkpoint.head) {
    await transferGit(
      directory,
      ["update-ref", "--no-deref", "HEAD", checkpoint.head],
      { importing: true }
    );
  }
  if (checkpoint.head) {
    const head = await gitText(directory, ["rev-parse", "HEAD"], {
      importing: true,
    });
    if (head !== checkpoint.head) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    const paths = await gitText(
      directory,
      ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
      { importing: true }
    );
    if (paths.split("\0").filter(Boolean).length > MAX_REPOSITORY_FILES) {
      throw new RepositoryTransferError("checkpoint_too_large");
    }
    for (const path of paths.split("\0").filter(Boolean)) {
      portableRepositoryPathSchema.parse(path);
    }
    await transferGit(directory, ["reset", "--mixed", "--quiet", "HEAD"], {
      importing: true,
    });
  }
  if (checkpoint.staged.bytes) {
    const patch = await content.path(checkpoint.staged);
    await transferGit(
      directory,
      ["apply", "--cached", "--check", "--binary", patch],
      { importing: true }
    );
    await transferGit(directory, ["apply", "--cached", "--binary", patch], {
      importing: true,
    });
  }
}

async function restoreWorkingFiles(
  directory: string,
  checkpoint: RepositoryCheckpoint,
  content: RepositoryContent
): Promise<void> {
  const directories = new Set<string>();
  for (const file of checkpoint.files) {
    const parts = portableRepositoryPathSchema.parse(file.path).split("/");
    await mkdir(join(directory, ...parts.slice(0, -1)), {
      recursive: true,
      mode: 0o700,
    });
    for (let length = 1; length < parts.length; length++) {
      directories.add(join(directory, ...parts.slice(0, length)));
    }
    const target = join(directory, ...parts);
    const handle = await open(
      target,
      "wx",
      file.mode === "100755" ? 0o700 : 0o600
    );
    try {
      await handle.writeFile(await readFile(await content.path(file.content)));
      await handle.chmod(file.mode === "100755" ? 0o700 : 0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const path of [...directories].sort(
    (left, right) => right.length - left.length
  )) {
    await syncDirectory(path);
  }
}
