import { workspaceMutationSchema } from "@chorus/contracts";
import { Elysia, t } from "elysia";
import type { WorkspaceStore } from "../workspace/store";

export function createWorkspaceRoutes(workspaceStore: WorkspaceStore) {
  return new Elysia()
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
        await workspaceStore.applyMutation(parsed.data);

        return workspaceStore.getSnapshot();
      },
      {
        body: t.Any(),
      }
    );
}
