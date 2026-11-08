import {
  apiErrorSchema,
  boardAutocompleteResponseSchema,
  type GitStatus,
  gitStatusSchema,
  type SessionFileDiff,
  sessionFileDiffsSchema,
} from "@chorus/contracts";

export type { GitStatus, SessionFileDiff } from "@chorus/contracts";

interface AutocompleteOptions {
  signal?: AbortSignal;
}

export interface OpencodeSkill {
  description?: string;
  name: string;
}

export interface OpencodeCommand {
  description?: string;
  name: string;
}

export interface OpencodeFileNode {
  name: string;
  path: string;
  type: "file" | "directory";
}

async function fetchBoardAutocomplete(
  boardId: string,
  query: URLSearchParams,
  options?: AutocompleteOptions
) {
  const url = `/api/boards/${encodeURIComponent(boardId)}/autocomplete?${query.toString()}`;
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(5000);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new Error(
      "Could not reach Chorus. Check the server connection and try again."
    );
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    throw new Error(
      parsedError.success
        ? parsedError.data.message
        : "Could not load board suggestions. Try again."
    );
  }

  const parsed = boardAutocompleteResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      "The server returned invalid board suggestions. Try again."
    );
  }
  return parsed.data;
}

export async function fetchSkills(
  boardId: string,
  options?: AutocompleteOptions
): Promise<OpencodeSkill[]> {
  const params = new URLSearchParams({ kind: "skills" });
  const result = await fetchBoardAutocomplete(boardId, params, options);
  if (result.kind !== "skills") {
    throw new Error(
      "The server returned the wrong board suggestions. Try again."
    );
  }
  return result.skills;
}

export async function fetchCommands(
  boardId: string,
  options?: AutocompleteOptions
): Promise<OpencodeCommand[]> {
  const params = new URLSearchParams({ kind: "commands" });
  const result = await fetchBoardAutocomplete(boardId, params, options);
  if (result.kind !== "commands") {
    throw new Error(
      "The server returned the wrong board suggestions. Try again."
    );
  }
  return result.commands;
}

export async function fetchFiles(
  boardId: string,
  query: string,
  options?: AutocompleteOptions
): Promise<string[]> {
  const params = new URLSearchParams({ kind: "files", query });
  const result = await fetchBoardAutocomplete(boardId, params, options);
  if (result.kind !== "files") {
    throw new Error(
      "The server returned the wrong board suggestions. Try again."
    );
  }
  return result.files;
}

export async function fetchDirectory(
  boardId: string,
  path: string,
  options?: AutocompleteOptions
): Promise<OpencodeFileNode[]> {
  const params = new URLSearchParams({ kind: "directory", path });
  const result = await fetchBoardAutocomplete(boardId, params, options);
  if (result.kind !== "directory") {
    throw new Error(
      "The server returned the wrong board suggestions. Try again."
    );
  }
  return result.entries.map((entry) => ({
    name: entry.path.split("/").filter(Boolean).at(-1) ?? entry.path,
    path: entry.path,
    type: entry.type,
  }));
}

export async function fetchSessionDiff(
  sessionId: string
): Promise<SessionFileDiff[]> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/diff`,
    { signal: AbortSignal.timeout(10_000) }
  );
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    throw new Error(
      error.success
        ? error.data.message
        : "Could not load session diffs. Try again."
    );
  }

  const parsed = sessionFileDiffsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("The server returned invalid diff data. Try again.");
  }
  return parsed.data;
}

export async function fetchGitStatus(
  directory: string,
  options?: AutocompleteOptions
): Promise<GitStatus> {
  const params = new URLSearchParams({ directory });
  const timeout = AbortSignal.timeout(10_000);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = await fetch(`/api/git/status?${params}`, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Repository status timed out. Retry.");
    }
    throw new Error(
      "Could not reach Chorus to load repository status. Check the connection and retry."
    );
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    throw new Error(
      parsedError.success
        ? parsedError.data.message
        : "Could not load repository status. Retry."
    );
  }

  const parsed = gitStatusSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      "The server returned invalid repository status. Refresh the board and retry."
    );
  }

  return parsed.data;
}
