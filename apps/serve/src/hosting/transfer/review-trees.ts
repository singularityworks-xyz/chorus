import {
  MAX_REPOSITORY_CHECKPOINT_BYTES,
  MAX_REPOSITORY_FILE_BYTES,
  MAX_REPOSITORY_FILES,
  portableRepositoryPathSchema,
  type ReviewCheckpoint,
} from "@chorus/contracts";
import { gitText, RepositoryTransferError } from "./git";

const TREE_ENTRY = /^(100644|100755) blob ([a-f0-9]+) +(\d+)\t(.+)$/s;

/** Inspect bounded regular-file trees without checking out or executing their content. */
export async function verifyReviewTrees(
  directory: string,
  trees: ReviewCheckpoint["trees"],
  importing: boolean
) {
  let totalBytes = 0;
  let files = 0;
  for (const tree of trees) {
    if (
      (await gitText(directory, ["cat-file", "-t", tree], { importing })) !==
      "tree"
    ) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    const entries = await gitText(
      directory,
      ["ls-tree", "-r", "-l", "-z", tree],
      { importing }
    );
    const paths = new Set<string>();
    for (const entry of entries.split("\0").filter(Boolean)) {
      const parsed = TREE_ENTRY.exec(entry);
      const path = parsed?.[4];
      const bytes = Number(parsed?.[3]);
      if (
        !(
          path &&
          Number.isSafeInteger(bytes) &&
          portableRepositoryPathSchema.safeParse(path).success
        ) ||
        paths.has(path.toLowerCase())
      ) {
        throw new RepositoryTransferError("checkpoint_invalid");
      }
      paths.add(path.toLowerCase());
      files++;
      totalBytes += bytes;
      if (
        bytes > MAX_REPOSITORY_FILE_BYTES ||
        files > MAX_REPOSITORY_FILES ||
        totalBytes > MAX_REPOSITORY_CHECKPOINT_BYTES
      ) {
        throw new RepositoryTransferError("checkpoint_too_large");
      }
    }
    for (const path of paths) {
      const segments = path.split("/");
      if (
        segments
          .slice(0, -1)
          .some((_, index) => paths.has(segments.slice(0, index + 1).join("/")))
      ) {
        throw new RepositoryTransferError("checkpoint_invalid");
      }
    }
  }
}
