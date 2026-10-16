import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  MAX_REPOSITORY_CHECKPOINT_BYTES,
  MAX_REPOSITORY_FILES,
} from "@chorus/contracts";
import { gitText, RepositoryTransferError, readGitIndex } from "./git";
import { isControlPath } from "./working-files";

export async function preflight(root: string) {
  if (
    (await gitText(root, ["rev-parse", "--is-shallow-repository"])) !==
      "false" ||
    (await gitText(root, ["rev-parse", "--is-inside-work-tree"])) !== "true"
  ) {
    throw new RepositoryTransferError("repository_not_ready");
  }
  const top = await realpath(
    await gitText(root, ["rev-parse", "--show-toplevel"])
  );
  if (relative(root, top) !== "") {
    throw new RepositoryTransferError("repository_not_ready");
  }
  const alternates = await gitText(root, [
    "rev-parse",
    "--git-path",
    "objects/info/alternates",
  ]);
  if (existsSync(resolve(root, alternates))) {
    throw new RepositoryTransferError("repository_not_ready");
  }
  const modes = await readGitIndex(root);
  // Capture avoids `git status` and external filters. Repositories requiring
  // filters also need a separate portability contract for their external data.
  const paths = (
    await gitText(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .split("\0")
    .filter((path) => path && !isControlPath(path));
  if (paths.length > MAX_REPOSITORY_FILES) {
    throw new RepositoryTransferError("checkpoint_too_large");
  }
  await assertNoFilters(root, paths);
  const flags = await gitText(root, ["ls-files", "-v", "-z"]);
  if (
    flags
      .split("\0")
      .filter(Boolean)
      .some((line) => !line.startsWith("H "))
  ) {
    throw new RepositoryTransferError("repository_not_ready");
  }
  const visible = await gitText(root, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--ita-visible-in-index",
  ]);
  const invisible = await gitText(root, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--ita-invisible-in-index",
  ]);
  if (visible !== invisible) {
    throw new RepositoryTransferError("repository_not_ready");
  }
  const size = await gitText(root, ["count-objects", "-v"]);
  const entries = Object.fromEntries(
    size.split("\n").map((line) => line.trim().split(": "))
  );
  if (
    (Number(entries.size ?? 0) + Number(entries["size-pack"] ?? 0)) * 1024 >
    MAX_REPOSITORY_CHECKPOINT_BYTES
  ) {
    throw new RepositoryTransferError("checkpoint_too_large");
  }
  return modes;
}

async function assertNoFilters(root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  const attributes = (
    await gitText(root, ["check-attr", "-z", "filter", "--stdin"], {
      input: `${paths.join("\0")}\0`,
    })
  ).split("\0");
  for (let index = 2; index < attributes.length; index += 3) {
    if (attributes[index] !== "unspecified") {
      throw new RepositoryTransferError("repository_not_ready");
    }
  }
}
