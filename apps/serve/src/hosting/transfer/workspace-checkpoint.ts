import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  MAX_WORKSPACE_CHECKPOINT_BYTES,
  type WorkspaceCheckpoint,
  workspaceCheckpointSchema,
} from "@chorus/contracts";
import { ensurePrivateHostDirectory } from "../private-directory";
import { RepositoryContent } from "./content";
import { syncDirectory } from "./durability";
import { RepositoryTransferError } from "./git";
import { stageReviewObjects } from "./review-objects";
import { stageRepositoryFamily } from "./stage-repository-family";
import { verifiedCheckpoint } from "./verified-checkpoint";
import {
  encodeWorkspaceManifest,
  readWorkspaceManifest,
  writeWorkspaceManifest,
} from "./workspace-manifest";
import {
  type CheckoutSource,
  checkoutReferences,
  copyWorkspaceSources,
  prepareWorkspaceSources,
} from "./workspace-sources";
import {
  restoreWorkspaceState,
  type WorkspaceCheckoutBinding,
} from "./workspace-state";

async function verifyContents(
  checkpoint: WorkspaceCheckpoint,
  content: RepositoryContent
) {
  const checkouts = await lstat(join(content.root, "checkouts"));
  if (!checkouts.isDirectory() || checkouts.isSymbolicLink()) {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
  let bytes = 0;
  for (const reference of checkoutReferences(checkpoint)) {
    const { checkpoint: repository } = await verifiedCheckpoint(
      join(content.root, "checkouts", reference.checkoutId),
      reference.checkpointHash
    );
    bytes +=
      repository.staged.bytes +
      (repository.history?.bytes ?? 0) +
      repository.files.reduce((sum, file) => sum + file.content.bytes, 0);
    if (bytes > MAX_WORKSPACE_CHECKPOINT_BYTES) {
      throw new RepositoryTransferError("checkpoint_too_large");
    }
  }
  for (const repository of checkpoint.repositories) {
    for (const review of repository.reviews) {
      bytes += review.checkpoint.objects.bytes;
      if (bytes > MAX_WORKSPACE_CHECKPOINT_BYTES) {
        throw new RepositoryTransferError("checkpoint_too_large");
      }
      await content.path(review.checkpoint.objects);
    }
  }
}

/** Packages already-quiesced, captured checkouts under a single hash chain. Never copies a live DB. */
export async function publishWorkspaceCheckpoint(
  input: WorkspaceCheckpoint,
  sources: CheckoutSource[],
  directory: string
) {
  const checkpoint = workspaceCheckpointSchema.parse(input);
  encodeWorkspaceManifest(checkpoint);
  const verified = await prepareWorkspaceSources(checkpoint, sources);
  const content = await RepositoryContent.create(directory);
  try {
    await mkdir(join(content.root, "checkouts"), { mode: 0o700 });
    await copyWorkspaceSources(checkpoint, verified, content);
    await verifyContents(checkpoint, content);
    const digest = await writeWorkspaceManifest(content.root, checkpoint);
    await syncDirectory(join(content.root, "data"));
    await syncDirectory(join(content.root, "checkouts"));
    await syncDirectory(content.root);
    await syncDirectory(dirname(content.root));
    return { directory: content.root, digest };
  } catch (error) {
    if (resolve(content.root) === resolve(directory)) {
      await rm(content.root, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Produces a verified inactive candidate; no store/engine/authority activation occurs. */
export async function stageWorkspaceCheckpoint(
  checkpointDirectory: string,
  digest: string,
  stagingParent: string
) {
  const content = await RepositoryContent.open(checkpointDirectory);
  const checkpoint = await readWorkspaceManifest(content.root, digest);
  await verifyContents(checkpoint, content);
  const parent = await ensurePrivateHostDirectory(stagingParent);
  const directory = await mkdtemp(join(parent, "workspace-"));
  try {
    const bindings: WorkspaceCheckoutBinding[] = [];
    const reviewStores: { checkoutId: string; directory: string }[] = [];
    for (const repository of checkpoint.repositories) {
      const family = await stageRepositoryFamily(
        {
          primary: {
            directory: join(
              content.root,
              "checkouts",
              repository.primary.checkoutId
            ),
            digest: repository.primary.checkpointHash,
          },
          worktrees: repository.worktrees.map((worktree) => ({
            directory: join(content.root, "checkouts", worktree.checkoutId),
            digest: worktree.checkpointHash,
            boardId: worktree.boardId,
          })),
        },
        directory
      );
      bindings.push({
        repositoryId: repository.repositoryId,
        checkoutId: repository.primary.checkoutId,
        repository: family.repository,
        checkout: family.repository,
      });
      for (const worktree of repository.worktrees) {
        const checkout = family.worktrees.get(worktree.boardId);
        if (!checkout) {
          throw new RepositoryTransferError("checkpoint_invalid");
        }
        bindings.push({
          repositoryId: repository.repositoryId,
          checkoutId: worktree.checkoutId,
          repository: family.repository,
          checkout,
        });
      }
      for (const review of repository.reviews) {
        reviewStores.push({
          checkoutId: review.checkoutId,
          directory: await stageReviewObjects(
            review.checkpoint,
            content,
            directory
          ),
        });
      }
    }
    const snapshot = restoreWorkspaceState(checkpoint.state, bindings);
    await syncDirectory(directory);
    await syncDirectory(parent);
    return {
      directory,
      snapshot,
      bindings,
      reviewStores,
      authority: checkpoint.state.authority,
    };
  } catch (error) {
    const target = resolve(directory);
    if (target.startsWith(`${resolve(parent)}${sep}`)) {
      await rm(target, { recursive: true, force: true });
    }
    throw error;
  }
}
