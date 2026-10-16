import { chmod, lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  gitObjectIdSchema,
  MAX_REPOSITORY_CHECKPOINT_BYTES,
  MAX_REPOSITORY_FILE_BYTES,
  type RepositoryCheckpoint,
  repositoryCheckpointSchema,
} from "@chorus/contracts";
import { isInside } from "../../paths/sandbox";
import { RepositoryContent } from "./content";
import { gitText, RepositoryTransferError, transferGit } from "./git";
import { preflight } from "./preflight";
import { captureFiles, verifyWorkingFiles } from "./working-files";

const DIFF_ARGS = [
  "diff",
  "--cached",
  "--binary",
  "--full-index",
  "--no-ext-diff",
  "--no-textconv",
];

async function repositoryState(root: string) {
  const [head, branch, refs, paths] = await Promise.all([
    gitText(root, ["rev-parse", "--verify", "--quiet", "HEAD"], {
      allowFailure: true,
    }),
    gitText(root, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true }),
    gitText(root, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/",
      "refs/tags/",
      "refs/remotes/",
    ]),
    gitText(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  return { head, branch, refs, paths };
}

/** Caller must quiesce engines first. Capture never changes the source checkout. */
export async function captureRepository(
  directory: string,
  checkpointDirectory: string
) {
  const root = await realpath(directory);
  if (isInside(root, checkpointDirectory)) {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
  const modes = await preflight(root);
  const before = await repositoryState(root);
  const content = await RepositoryContent.create(checkpointDirectory);
  try {
    return await captureInto(root, modes, before, content);
  } catch (error) {
    const parent = await realpath(dirname(checkpointDirectory));
    if (content.root !== parent && isInside(parent, content.root)) {
      await rm(content.root, { recursive: true, force: true });
    }
    throw error;
  }
}

async function captureInto(
  root: string,
  modes: Map<string, "100644" | "100755">,
  before: Awaited<ReturnType<typeof repositoryState>>,
  content: RepositoryContent
) {
  const objectFormat = await gitText(root, [
    "rev-parse",
    "--show-object-format",
  ]);
  const checkpoint: RepositoryCheckpoint = {
    version: 1,
    objectFormat:
      repositoryCheckpointSchema.shape.objectFormat.parse(objectFormat),
    head: before.head ? gitObjectIdSchema.parse(before.head) : null,
    branch: before.branch || null,
    refs: before.refs
      ? before.refs.split("\n").map((line) => {
          const [name, oid] = line.split(" ");
          return { name: name ?? "", oid: oid ?? "" };
        })
      : [],
    history: null,
    staged: await content.put(
      (
        await transferGit(root, DIFF_ARGS, {
          maxBytes: MAX_REPOSITORY_FILE_BYTES,
        })
      ).bytes
    ),
    files: [],
  };
  let total = checkpoint.staged.bytes;
  checkpoint.history = await captureHistory(
    root,
    content,
    Boolean(before.head || checkpoint.refs.length),
    Boolean(before.head),
    MAX_REPOSITORY_CHECKPOINT_BYTES - total
  );
  total += checkpoint.history?.bytes ?? 0;
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
    .filter(Boolean);
  checkpoint.files = await captureFiles(
    root,
    modes,
    paths,
    content,
    MAX_REPOSITORY_CHECKPOINT_BYTES - total
  );
  const after = await repositoryState(root);
  const staged = (
    await transferGit(root, DIFF_ARGS, { maxBytes: MAX_REPOSITORY_FILE_BYTES })
  ).bytes;
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    !staged.equals(await readFile(await content.path(checkpoint.staged)))
  ) {
    throw new RepositoryTransferError("repository_changed");
  }
  await verifyWorkingFiles(root, modes, checkpoint.files, paths);
  const parsed = repositoryCheckpointSchema.parse(checkpoint);
  return {
    checkpoint: parsed,
    digest: await content.save(parsed),
    directory: content.root,
  };
}

async function captureHistory(
  root: string,
  content: RepositoryContent,
  hasHistory: boolean,
  hasHead: boolean,
  remaining: number
) {
  if (hasHistory) {
    const bundle = join(content.root, "history.bundle");
    try {
      await transferGit(root, [
        "bundle",
        "create",
        bundle,
        "--branches",
        "--tags",
        "--remotes",
        ...(hasHead ? ["HEAD"] : []),
      ]);
      await chmod(bundle, 0o600);
      const metadata = await lstat(bundle);
      if (metadata.size > remaining) {
        throw new RepositoryTransferError("checkpoint_too_large");
      }
      return await content.put(await readFile(bundle));
    } finally {
      await rm(bundle, { force: true });
    }
  }
  return null;
}
