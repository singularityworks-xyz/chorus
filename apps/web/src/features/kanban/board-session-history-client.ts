import {
  apiErrorSchema,
  type BoardSessionHistoryCommand,
  type BoardSessionHistoryState,
  boardSessionHistoryCommandResponseSchema,
  boardSessionHistoryStateSchema,
} from "@chorus/contracts";

const SESSION_HISTORY_REQUEST_TIMEOUT_MS = 10_000;

type SessionHistoryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

class UnauthorizedSessionHistoryCommandError extends Error {}

function parseApiError(payload: unknown, fallback: string): string {
  const parsed = apiErrorSchema.safeParse(payload);
  return parsed.success ? parsed.data.message : fallback;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SESSION_HISTORY_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeRequestFailure(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.name === "TimeoutError") {
    return new Error(
      "Repository history took too long to respond. Refresh the board before trying again."
    );
  }
  if (error instanceof TypeError) {
    return new Error(
      "Could not reach Chorus. Check the board connection and retry."
    );
  }
  return error instanceof Error ? error : new Error(fallback);
}

export async function loadBoardSessionHistory(
  boardId: string,
  sessionId: string | undefined,
  options: {
    fetcher?: SessionHistoryFetch;
    signal?: AbortSignal;
  } = {}
): Promise<BoardSessionHistoryState> {
  const fallback =
    "Could not load repository history. Check the board connection and retry.";

  try {
    const response = await (options.fetcher ?? fetch)(
      `/api/boards/${encodeURIComponent(boardId)}/session/history`,
      {
        cache: "no-store",
        signal: requestSignal(options.signal),
      }
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(parseApiError(payload, fallback));
    }

    const history = boardSessionHistoryStateSchema.safeParse(payload);
    if (
      !history.success ||
      history.data.boardId !== boardId ||
      history.data.sessionId !== (sessionId ?? null)
    ) {
      throw new Error(
        "The repository history response did not match this board. Refresh the workspace and retry."
      );
    }

    return history.data;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    throw normalizeRequestFailure(error, fallback);
  }
}

export async function sendBoardSessionHistoryCommand(
  boardId: string,
  command: BoardSessionHistoryCommand,
  options: {
    fetcher?: SessionHistoryFetch;
    onUnauthorized?: (response: Response) => boolean;
  } = {}
) {
  const fallback = `Could not ${command} repository changes. Check the board connection and try again.`;

  try {
    const response = await (options.fetcher ?? fetch)(
      `/api/boards/${encodeURIComponent(boardId)}/session/history/${command}`,
      {
        method: "POST",
        signal: requestSignal(),
      }
    );

    if (options.onUnauthorized?.(response)) {
      throw new UnauthorizedSessionHistoryCommandError(
        "Your sign-in expired. Sign in again before changing repository history."
      );
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(parseApiError(payload, fallback));
    }

    const result = boardSessionHistoryCommandResponseSchema.safeParse(payload);
    if (
      !result.success ||
      result.data.boardId !== boardId ||
      result.data.command !== command
    ) {
      throw new Error(
        "The server response did not confirm the history change. Refresh the board before retrying."
      );
    }

    return result.data;
  } catch (error) {
    if (error instanceof UnauthorizedSessionHistoryCommandError) {
      throw error;
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        `The ${command} request timed out. It may still have completed; refresh repository history before retrying.`
      );
    }
    if (error instanceof TypeError) {
      throw new Error(
        `Could not confirm ${command}. Check repository history before retrying.`
      );
    }
    throw error instanceof Error ? error : new Error(fallback);
  }
}
