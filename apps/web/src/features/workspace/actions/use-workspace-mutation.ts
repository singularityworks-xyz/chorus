import type { WorkspaceMutation } from "@chorus/contracts";
import { useCallback, useState } from "react";
import { ChorusApiError } from "@/lib/chorus-api-error";
import {
  WORKSPACE_MUTATION_ERROR,
  workspaceActionErrorMessage,
  workspaceApiError,
} from "../workspace-action-error";

export type WorkspaceMutationInput = {
  [Mutation in WorkspaceMutation as Mutation["type"]]: Pick<
    Mutation,
    "payload" | "type"
  >;
}[WorkspaceMutation["type"]];

export type WorkspaceMutationFactory = (
  input: WorkspaceMutationInput
) => WorkspaceMutation;

export function createWorkspaceMutation(
  clientId: string,
  baseRevision: number,
  input: WorkspaceMutationInput
): WorkspaceMutation {
  return {
    baseRevision,
    clientId,
    mutationId: crypto.randomUUID(),
    ...input,
  };
}

export function useWorkspaceMutation(
  reportUnauthorized: (response: Response) => boolean
) {
  const [workspaceActionError, setWorkspaceActionError] = useState<
    string | null
  >(null);

  const mutateWorkspace = useCallback(
    async (mutation: WorkspaceMutation): Promise<void> => {
      try {
        const response = await fetch("/api/workspace", {
          body: JSON.stringify(mutation),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        });

        if (reportUnauthorized(response)) {
          throw new ChorusApiError("unauthorized", "unauthorized");
        }

        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => undefined);
          throw workspaceApiError(payload, WORKSPACE_MUTATION_ERROR);
        }

        setWorkspaceActionError(null);
      } catch (error) {
        if (
          !(error instanceof ChorusApiError && error.code === "unauthorized")
        ) {
          setWorkspaceActionError(
            workspaceActionErrorMessage(error, WORKSPACE_MUTATION_ERROR)
          );
        }
        throw error;
      }
    },
    [reportUnauthorized]
  );

  const dismissWorkspaceActionError = useCallback(() => {
    setWorkspaceActionError(null);
  }, []);

  return {
    dismissWorkspaceActionError,
    mutateWorkspace,
    setWorkspaceActionError,
    workspaceActionError,
  };
}
