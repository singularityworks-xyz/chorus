import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_WORKSPACE_CHECKPOINT_BYTES,
  type WorkspaceCheckpoint,
} from "@chorus/contracts";
import { RepositoryContent } from "./content";
import { RepositoryTransferError } from "./git";
import { verifiedCheckpoint } from "./verified-checkpoint";

export interface CheckoutSource {
  checkoutId: string;
  directory: string;
}

export function checkoutReferences(checkpoint: WorkspaceCheckpoint) {
  return checkpoint.repositories.flatMap((repository) => [
    repository.primary,
    ...repository.worktrees,
  ]);
}

export async function prepareWorkspaceSources(
  checkpoint: WorkspaceCheckpoint,
  sources: CheckoutSource[]
) {
  const references = checkoutReferences(checkpoint);
  const byId = new Map(
    sources.map((source) => [source.checkoutId, source.directory])
  );
  if (
    byId.size !== sources.length ||
    byId.size !== references.length ||
    references.some((reference) => !byId.has(reference.checkoutId))
  ) {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
  const verified = new Map<
    string,
    Awaited<ReturnType<typeof verifiedCheckpoint>>
  >();
  let totalBytes = 0;
  for (const reference of references) {
    const directory = byId.get(reference.checkoutId);
    if (!directory) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    const source = await verifiedCheckpoint(
      directory,
      reference.checkpointHash
    );
    totalBytes +=
      source.checkpoint.staged.bytes +
      (source.checkpoint.history?.bytes ?? 0) +
      source.checkpoint.files.reduce(
        (sum, file) => sum + file.content.bytes,
        0
      );
    if (totalBytes > MAX_WORKSPACE_CHECKPOINT_BYTES) {
      throw new RepositoryTransferError("checkpoint_too_large");
    }
    verified.set(reference.checkoutId, source);
  }
  for (const repository of checkpoint.repositories) {
    for (const review of repository.reviews) {
      totalBytes += review.checkpoint.objects.bytes;
      if (totalBytes > MAX_WORKSPACE_CHECKPOINT_BYTES) {
        throw new RepositoryTransferError("checkpoint_too_large");
      }
      const source = verified.get(review.checkoutId);
      if (!source) {
        throw new RepositoryTransferError("checkpoint_invalid");
      }
      await source.content.path(review.checkpoint.objects);
    }
  }
  return verified;
}

export async function copyWorkspaceSources(
  checkpoint: WorkspaceCheckpoint,
  verified: Awaited<ReturnType<typeof prepareWorkspaceSources>>,
  content: RepositoryContent
) {
  for (const reference of checkoutReferences(checkpoint)) {
    const source = verified.get(reference.checkoutId);
    if (!source) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    const target = await RepositoryContent.create(
      join(content.root, "checkouts", reference.checkoutId)
    );
    for (const payload of [
      source.checkpoint.staged,
      ...(source.checkpoint.history ? [source.checkpoint.history] : []),
      ...source.checkpoint.files.map((file) => file.content),
    ]) {
      await target.put(await readFile(await source.content.path(payload)));
    }
    if ((await target.save(source.checkpoint)) !== reference.checkpointHash) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
  }
  for (const repository of checkpoint.repositories) {
    for (const review of repository.reviews) {
      const source = verified.get(review.checkoutId);
      if (!source) {
        throw new RepositoryTransferError("checkpoint_invalid");
      }
      await content.put(
        await readFile(await source.content.path(review.checkpoint.objects))
      );
    }
  }
}
