import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  gitObjectIdSchema,
  MAX_REPOSITORY_CHECKPOINT_BYTES,
  type ReviewCheckpoint,
  reviewCheckpointSchema,
} from "@chorus/contracts";
import { z } from "zod";
import { ensurePrivateHostDirectory } from "../private-directory";
import type { RepositoryContent } from "./content";
import { syncDirectory } from "./durability";
import { gitText, RepositoryTransferError, transferGit } from "./git";
import { verifyReviewTrees } from "./review-trees";

/** Source must be the host's trusted bare snapshot store, never a browser path. */
export async function captureReviewObjects(
  snapshotDirectory: string,
  roots: string[],
  content: RepositoryContent
): Promise<ReviewCheckpoint> {
  const trees = z
    .array(gitObjectIdSchema)
    .min(1)
    .max(10_000)
    .parse([...new Set(roots)]);
  const directory = await realpath(snapshotDirectory);
  if (
    (await gitText(directory, ["rev-parse", "--is-bare-repository"], {
      importing: true,
    })) !== "true"
  ) {
    throw new RepositoryTransferError("repository_not_ready");
  }
  const objectFormat = reviewCheckpointSchema.shape.objectFormat.parse(
    await gitText(directory, ["rev-parse", "--show-object-format"], {
      importing: true,
    })
  );
  await verifyReviewTrees(directory, trees, true);
  const packed = await transferGit(
    directory,
    ["pack-objects", "--stdout", "--revs"],
    {
      importing: true,
      input: `${trees.join("\n")}\n`,
      maxBytes: MAX_REPOSITORY_CHECKPOINT_BYTES,
    }
  );
  return reviewCheckpointSchema.parse({
    version: 1,
    objectFormat,
    trees,
    objects: await content.put(packed.bytes),
  });
}

/** Creates an inactive bare store. Activation must install it for the remapped checkout. */
export async function stageReviewObjects(
  input: ReviewCheckpoint,
  content: RepositoryContent,
  stagingParent: string
): Promise<string> {
  const checkpoint = reviewCheckpointSchema.parse(input);
  const packed = await content.path(checkpoint.objects);
  const parent = await ensurePrivateHostDirectory(stagingParent);
  const directory = await mkdtemp(join(parent, "review-"));
  try {
    await transferGit(
      directory,
      [
        "init",
        "--quiet",
        "--bare",
        "--template=",
        `--object-format=${checkpoint.objectFormat}`,
      ],
      { importing: true }
    );
    await transferGit(directory, ["index-pack", "--stdin", "--strict"], {
      importing: true,
      input: await readFile(packed),
    });
    await transferGit(directory, ["fsck", "--full", "--strict"], {
      importing: true,
    });
    await verifyReviewTrees(directory, checkpoint.trees, true);
    await transferGit(directory, ["update-ref", "--stdin"], {
      importing: true,
      input: checkpoint.trees
        .map((tree) => `update refs/chorus/review/${tree} ${tree}\n`)
        .join(""),
    });
    await syncDirectory(join(directory, "objects", "pack"));
    await syncDirectory(join(directory, "objects"));
    await syncDirectory(join(directory, "refs", "chorus", "review"));
    await syncDirectory(join(directory, "refs", "chorus"));
    await syncDirectory(join(directory, "refs"));
    await syncDirectory(directory);
    await syncDirectory(parent);
    return directory;
  } catch (error) {
    const target = resolve(directory);
    if (target.startsWith(`${resolve(parent)}${sep}`)) {
      await rm(target, { recursive: true, force: true });
    }
    throw error;
  }
}
