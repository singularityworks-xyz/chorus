import { apiErrorSchema } from "@chorus/contracts";
import { ChorusApiError } from "@/lib/chorus-api-error";

export const WORKSPACE_MUTATION_ERROR =
  "Chorus could not confirm this workspace change. Refresh the workspace before retrying.";

export const OPEN_FOLDER_ERROR =
  "Could not open a repository folder. Check the connection and try again.";

export function workspaceApiError(
  payload: unknown,
  fallback: string
): ChorusApiError {
  const parsed = apiErrorSchema.safeParse(payload);
  return new ChorusApiError(
    parsed.success ? parsed.data.code : "workspace_action_failed",
    parsed.success ? parsed.data.message : fallback
  );
}

export function workspaceActionErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof ChorusApiError && error.code !== "unauthorized") {
    return error.message;
  }

  return fallback;
}
