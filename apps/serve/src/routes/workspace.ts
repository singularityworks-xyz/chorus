import { workspaceMutationSchema } from "@chorus/contracts";
import { Elysia, t } from "elysia";
import type { WsClientManager } from "../events/broadcaster";
import type { WorkspaceStore } from "../workspace/store";

export function createWorkspaceMessage(snapshot: unknown) {
  return JSON.stringify({
    type: "workspace.updated",
    payload: snapshot,
    timestamp: Date.now(),
  });
}

export function createWorkspaceRoutes(
  workspaceStore: WorkspaceStore,
  wsManager: WsClientManager
) {
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

        // Returns null when the mutationId was already applied (a retried
        // request) or addressed nothing — both are no-ops the client already
        // has the answer for, so respond with current state and stay quiet.
        const commit = await workspaceStore.applyMutation(parsed.data);
        const snapshot = workspaceStore.getSnapshot();

        if (commit) {
          // Legacy whole-snapshot fan-out. Phase 3 replaces this with the hub
          // replaying the commit's sequenced events, at which point this
          // broadcast disappears entirely.
          wsManager.broadcastRaw(createWorkspaceMessage(snapshot));
        }

        return snapshot;
      },
      {
        body: t.Any(),
      }
    );
}
