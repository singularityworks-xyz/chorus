import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  MAX_REPOSITORY_CHECKPOINT_BYTES,
  portableRepositoryPathSchema,
  sha256Schema,
} from "@chorus/contracts";
import { z } from "zod";
import { ensurePrivateHostDirectory } from "../private-directory";
import { syncDirectory } from "./durability";
import { gitText, RepositoryTransferError, transferGit } from "./git";
import { restoreCheckpoint, stageRepository } from "./stage-repository";
import { verifiedCheckpoint } from "./verified-checkpoint";

const checkpointInputSchema = z.strictObject({
  directory: z.string().min(1),
  digest: sha256Schema,
});
const familyInputSchema = z.strictObject({
  primary: checkpointInputSchema,
  worktrees: z
    .array(
      checkpointInputSchema.extend({
        boardId: portableRepositoryPathSchema.refine(
          (path) => !path.includes("/")
        ),
      })
    )
    .max(100),
});
export type RepositoryFamilyInput = z.infer<typeof familyInputSchema>;

/** Every directory this module can mutate belongs to its fresh inactive family. */
export async function stageRepositoryFamily(
  input: RepositoryFamilyInput,
  stagingParent: string
) {
  const family = familyInputSchema.parse(input);
  const primary = await verifiedCheckpoint(
    family.primary.directory,
    family.primary.digest
  );
  const worktrees: (Awaited<ReturnType<typeof verifiedCheckpoint>> & {
    boardId: string;
  })[] = [];
  const names = new Set<string>();
  const branches = new Set(
    primary.checkpoint.branch ? [primary.checkpoint.branch.toLowerCase()] : []
  );
  const checkpointBytes = (checkpoint: typeof primary.checkpoint) =>
    checkpoint.staged.bytes +
    (checkpoint.history?.bytes ?? 0) +
    checkpoint.files.reduce((total, file) => total + file.content.bytes, 0);
  let totalBytes = checkpointBytes(primary.checkpoint);
  for (const inputWorktree of family.worktrees) {
    const worktree = await verifiedCheckpoint(
      inputWorktree.directory,
      inputWorktree.digest
    );
    const refs = (values: typeof worktree.checkpoint.refs) =>
      JSON.stringify([...values].sort((a, b) => a.name.localeCompare(b.name)));
    const branch = worktree.checkpoint.branch?.toLowerCase();
    totalBytes += checkpointBytes(worktree.checkpoint);
    if (totalBytes > 4 * MAX_REPOSITORY_CHECKPOINT_BYTES) {
      throw new RepositoryTransferError("checkpoint_too_large");
    }
    if (
      !(primary.checkpoint.head && worktree.checkpoint.head) ||
      primary.checkpoint.objectFormat !== worktree.checkpoint.objectFormat ||
      refs(primary.checkpoint.refs) !== refs(worktree.checkpoint.refs) ||
      names.has(inputWorktree.boardId.toLowerCase()) ||
      (branch && branches.has(branch))
    ) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    names.add(inputWorktree.boardId.toLowerCase());
    if (branch) {
      branches.add(branch);
    }
    worktrees.push({ ...worktree, boardId: inputWorktree.boardId });
  }
  const parent = await ensurePrivateHostDirectory(stagingParent);
  const directory = await mkdtemp(join(parent, "family-"));
  try {
    const repository = await stageRepository(
      family.primary.directory,
      family.primary.digest,
      directory
    );
    const paths = new Map<string, string>();
    for (const worktree of worktrees) {
      const path = join(repository, ".chorus-worktrees", worktree.boardId);
      await mkdir(join(repository, ".chorus-worktrees"), {
        recursive: true,
        mode: 0o700,
      });
      // Detached worktree history may not be reachable from a shared branch.
      if (worktree.checkpoint.history) {
        const history = await worktree.content.path(
          worktree.checkpoint.history
        );
        await transferGit(repository, ["bundle", "verify", history], {
          importing: true,
        });
        await transferGit(repository, ["bundle", "unbundle", history], {
          importing: true,
        });
        await transferGit(repository, ["fsck", "--full", "--strict"], {
          importing: true,
        });
      }
      await transferGit(
        repository,
        [
          "worktree",
          "add",
          "--quiet",
          "--detach",
          "--no-checkout",
          path,
          worktree.checkpoint.head ?? "",
        ],
        { importing: true }
      );
      await restoreCheckpoint(
        path,
        worktree.checkpoint,
        worktree.content,
        true
      );
      const gitDirectory = await gitText(
        path,
        ["rev-parse", "--absolute-git-dir"],
        { importing: true }
      );
      await syncDirectory(gitDirectory);
      await syncDirectory(path);
      paths.set(worktree.boardId, path);
    }
    if (paths.size) {
      await syncDirectory(join(repository, ".git", "worktrees"));
      await syncDirectory(join(repository, ".chorus-worktrees"));
    }
    await syncDirectory(join(repository, ".git"));
    await syncDirectory(repository);
    await syncDirectory(directory);
    await syncDirectory(parent);
    return { directory, repository, worktrees: paths };
  } catch (error) {
    const target = resolve(directory);
    if (target.startsWith(`${resolve(parent)}${sep}`)) {
      await rm(target, { recursive: true, force: true });
    }
    throw error;
  }
}
