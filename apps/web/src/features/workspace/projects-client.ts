import { apiErrorSchema, projectListResponseSchema } from "@chorus/contracts";

export const PROJECT_LIST_ERROR =
  "Could not load known projects. Check the connection and retry.";

const PROJECT_LIST_REQUEST_TIMEOUT_MS = 10_000;

type ProjectListFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export async function requestRecentProjects({
  fetcher = fetch,
  onUnauthorized,
  signal,
}: {
  fetcher?: ProjectListFetch;
  onUnauthorized?: (response: Response) => boolean;
  signal?: AbortSignal;
} = {}) {
  try {
    const timeout = AbortSignal.timeout(PROJECT_LIST_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetcher("/api/projects", {
      cache: "no-store",
      signal: requestSignal,
    });

    if (signal?.aborted) {
      return null;
    }

    if (onUnauthorized?.(response)) {
      return null;
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(payload);
      throw new Error(error.success ? error.data.message : PROJECT_LIST_ERROR);
    }

    const projects = projectListResponseSchema.safeParse(payload);
    if (!projects.success) {
      throw new Error(
        "Chorus returned an invalid known-project list. Retry to refresh it."
      );
    }

    return projects.data.projects;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        "Loading known projects timed out. Retry to refresh the list."
      );
    }
    if (error instanceof TypeError) {
      throw new Error(
        "Could not reach Chorus. Check the connection and retry."
      );
    }
    throw error instanceof Error ? error : new Error(PROJECT_LIST_ERROR);
  }
}
