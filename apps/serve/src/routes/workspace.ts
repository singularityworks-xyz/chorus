import { workspaceMutationSchema } from "@chorus/contracts";
import { Elysia, t } from "elysia";
import { RepositoryRegistryError } from "../projects/repository-registry";
import { WorktreeNotCleanError } from "../projects/worktree-manager";
import type { BoardTaskService } from "../tasks/board-task-service";
import { BoardLifecycleError } from "../tasks/board-task-service";
import type { WorkspaceStore } from "../workspace/store";

export function createWorkspaceRoutes(
  workspaceStore: WorkspaceStore,
  boardTasks?: Pick<BoardTaskService, "removeBoard">
) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof WorktreeNotCleanError) {
        set.status = 409;
        return {
          code: "worktree_not_clean",
          message: error.message,
        };
      }
      if (error instanceof BoardLifecycleError) {
        set.status = error.code === "board_abort_failed" ? 504 : 409;
        return { code: error.code, message: error.message };
      }
      if (error instanceof RepositoryRegistryError) {
        set.status = error.code === "unregistered_repository_root" ? 403 : 400;
        return { code: error.code, message: error.message };
      }
      return undefined;
    })
    .get("/workspace", () => workspaceStore.getSnapshot())
    .post(
      "/workspace/mutations",
      async ({ body, set }) => {
        const parsed = workspaceMutationSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 422;
          return {
            code: "invalid_workspace_mutation",
            issues: parsed.error.issues,
          };
        }

        // The store's own commit hook publishes to the hub, so this route does
        // not broadcast: there is exactly one emit path and it is not here.
        // Returns null when the mutationId was already applied or the
        // mutation addressed nothing — both no-ops the client already has the
        // answer for.
        if (parsed.data.type === "board.remove" && boardTasks) {
          await boardTasks.removeBoard(parsed.data);
        } else {
          await workspaceStore.applyMutation(parsed.data);
        }

        return workspaceStore.getSnapshot();
      },
      {
        body: t.Any(),
      }
    );
}
