import {
  type SessionFileDiff,
  sessionFileDiffsSchema,
} from "@chorus/contracts";
import posthog from "posthog-js";

export type { SessionFileDiff } from "@chorus/contracts";

const OPENCODE_BASE_URL =
  process.env.NEXT_PUBLIC_OPENCODE_URL ?? "http://localhost:4096";

const IS_DEV = process.env.NODE_ENV !== "production";

interface FetchOptions {
  directory?: string;
}

function logApiError(
  url: string,
  response: Response,
  context?: Record<string, unknown>
) {
  if (IS_DEV) {
    console.error(`[opencode-client] HTTP ${response.status}`, {
      url,
      context,
    });
  }
  posthog.capture("opencode_api_error", {
    url,
    status: response.status,
    statusText: response.statusText,
    context,
  });
}

async function safeFetch<T>(
  url: string,
  context?: Record<string, unknown>
): Promise<T> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      logApiError(url, response, context);
      return [] as unknown as T;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      if (IS_DEV) {
        console.error(
          `[opencode-client] Expected JSON but got: ${contentType}`,
          { url, context }
        );
      }
      posthog.capture("opencode_api_wrong_content_type", {
        url,
        contentType,
        context,
      });
      return [] as unknown as T;
    }

    const text = await response.text();
    if (!text) {
      return [] as unknown as T;
    }
    return JSON.parse(text) as T;
  } catch (error) {
    if (IS_DEV) {
      console.error("[opencode-client] Fetch failed", {
        url,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.name : typeof error,
        context,
      });
    }
    posthog.capture("opencode_api_failed", {
      url,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.name : typeof error,
      context,
    });
    return [] as unknown as T;
  }
}

export interface OpencodeSkill {
  content: string;
  description: string;
  location: string;
  name: string;
}

export interface OpencodeCommand {
  agent?: string;
  description?: string;
  hints: string[];
  model?: string;
  name: string;
  source?: "command" | "mcp" | "skill";
  subtask?: boolean;
  template: string;
}

export interface OpencodeFileNode {
  absolute: string;
  ignored?: boolean;
  name: string;
  path: string;
  type: "file" | "directory";
}

export async function fetchSkills(
  _options?: FetchOptions
): Promise<OpencodeSkill[]> {
  return await safeFetch<OpencodeSkill[]>(`${OPENCODE_BASE_URL}/skill`, {
    endpoint: "skill",
  });
}

export async function fetchCommands(
  _options?: FetchOptions
): Promise<OpencodeCommand[]> {
  return await safeFetch<OpencodeCommand[]>(`${OPENCODE_BASE_URL}/command`, {
    endpoint: "command",
  });
}

export async function fetchFiles(
  query: string,
  options?: FetchOptions
): Promise<string[]> {
  const params = new URLSearchParams({
    query: query || ".",
    limit: "50",
  });
  if (options?.directory) {
    params.set("directory", options.directory);
  }
  return await safeFetch<string[]>(`${OPENCODE_BASE_URL}/find/file?${params}`, {
    endpoint: "find/file",
    query,
    ...options,
  });
}

export async function fetchDirectory(
  path: string,
  options?: FetchOptions
): Promise<OpencodeFileNode[]> {
  const params = new URLSearchParams({ path });
  if (options?.directory) {
    params.set("directory", options.directory);
  }
  return await safeFetch<OpencodeFileNode[]>(
    `${OPENCODE_BASE_URL}/file?${params}`,
    {
      endpoint: "file",
      path,
      ...options,
    }
  );
}

export async function fetchSessionDiff(
  sessionId: string
): Promise<SessionFileDiff[]> {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/diff`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("[opencode-client] Failed to fetch session diff", {
        sessionId,
        status: response.status,
      });
      return [];
    }
    const text = await response.text();
    if (!text) {
      return [];
    }
    const parsed = sessionFileDiffsSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      console.error("[opencode-client] Invalid session diff response", {
        sessionId,
      });
      return [];
    }
    return parsed.data;
  } catch (error) {
    if (IS_DEV) {
      console.error("[opencode-client] Fetch session diff failed", {
        sessionId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

export interface GitStatus {
  ahead: number;
  behind: number;
  branch: string;
  linesAdded: number;
  linesRemoved: number;
  modified: number;
  staged: number;
  timestamp: number;
  tracking: string | null;
  untracked: number;
}

export async function fetchGitStatus(
  directory: string
): Promise<GitStatus | null> {
  try {
    const params = new URLSearchParams({ directory });
    const response = await fetch(`/api/git/status?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("[opencode-client] Failed to fetch git status", {
        directory,
        status: response.status,
      });
      return null;
    }
    const text = await response.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text) as GitStatus;
  } catch (error) {
    if (IS_DEV) {
      console.error("[opencode-client] Fetch git status failed", {
        directory,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}
