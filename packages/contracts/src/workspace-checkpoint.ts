import { z } from "zod";
import { sha256Schema } from "./hosting";
import { portableRepositoryPathSchema } from "./repository-transfer";
import { reviewCheckpointSchema } from "./review-transfer";
import { portableWorkspaceStateSchema } from "./workspace-transfer";

export const MAX_WORKSPACE_CHECKPOINT_BYTES = 1024 * 1024 * 1024;
export const MAX_WORKSPACE_MANIFEST_BYTES = 16 * 1024 * 1024;
export const workspaceCheckoutReferenceSchema = z.strictObject({
  checkoutId: z.uuid(),
  checkpointHash: sha256Schema,
});
export const workspaceCheckpointSchema = z
  .strictObject({
    version: z.literal(1),
    state: portableWorkspaceStateSchema,
    repositories: z
      .array(
        z.strictObject({
          repositoryId: z.uuid(),
          primary: workspaceCheckoutReferenceSchema,
          worktrees: z
            .array(
              workspaceCheckoutReferenceSchema.extend({
                boardId: portableRepositoryPathSchema.refine(
                  (path) => !path.includes("/")
                ),
              })
            )
            .max(100),
          reviews: z
            .array(
              z.strictObject({
                checkoutId: z.uuid(),
                checkpoint: reviewCheckpointSchema,
              })
            )
            .max(101),
        })
      )
      .max(100),
  })
  .superRefine((value, context) => {
    const checkouts = new Map<string, string>();
    const repositories = new Set<string>();
    let valid = true;
    for (const repository of value.repositories) {
      if (repositories.has(repository.repositoryId)) {
        valid = false;
      }
      repositories.add(repository.repositoryId);
      const names = repository.worktrees.map((worktree) =>
        worktree.boardId.toLowerCase()
      );
      if (new Set(names).size !== names.length) {
        valid = false;
      }
      const own = new Set<string>();
      for (const checkout of [repository.primary, ...repository.worktrees]) {
        if (checkouts.has(checkout.checkoutId)) {
          valid = false;
        }
        own.add(checkout.checkoutId);
        checkouts.set(checkout.checkoutId, repository.repositoryId);
      }
      const reviews = new Set<string>();
      for (const review of repository.reviews) {
        if (!own.has(review.checkoutId) || reviews.has(review.checkoutId)) {
          valid = false;
        }
        reviews.add(review.checkoutId);
      }
    }
    for (const { repo } of [
      ...value.state.boards,
      ...value.state.previousWorkspaces,
    ]) {
      if (
        [repo.checkoutId, ...repo.sandboxCheckoutIds].some(
          (id) => checkouts.get(id) !== repo.repositoryId
        )
      ) {
        valid = false;
      }
    }
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "workspace checkout graph is inconsistent",
      });
    }
  })
  .refine(
    (value) => {
      const checkouts = value.state.boards.map(
        (board) => board.repo.checkoutId
      );
      const worktreeBoards = new Map(
        value.repositories.flatMap((repository) =>
          repository.worktrees.map(
            (worktree) => [worktree.checkoutId, worktree.boardId] as const
          )
        )
      );
      return (
        new Set(checkouts).size === checkouts.length &&
        value.state.boards.every(
          (board) =>
            !worktreeBoards.has(board.repo.checkoutId) ||
            worktreeBoards.get(board.repo.checkoutId) === board.boardId
        )
      );
    },
    { message: "boards must retain separate, correctly named checkouts" }
  );
export type WorkspaceCheckpoint = z.infer<typeof workspaceCheckpointSchema>;
