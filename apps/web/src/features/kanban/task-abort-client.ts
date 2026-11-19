import { requireAcceptedCommand } from "./command-client";

const TASK_ABORT_REQUEST_TIMEOUT_MS = 10_000;

type TaskAbortFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export async function abortBoardTask(
  boardId: string,
  taskId: string,
  fetcher: TaskAbortFetch = fetch
): Promise<void> {
  try {
    const response = await fetcher(
      `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/abort`,
      {
        method: "POST",
        signal: AbortSignal.timeout(TASK_ABORT_REQUEST_TIMEOUT_MS),
      }
    );
    await requireAcceptedCommand(response, {
      fallback:
        "Could not stop this task. Refresh the board to check its status before trying again.",
      rejectedMessage:
        "The engine did not accept the stop request. The task is still running.",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        "The stop request timed out. The task may still be running; refresh the board before retrying."
      );
    }
    if (error instanceof TypeError) {
      throw new Error(
        "Could not reach Chorus. Check the connection and refresh the board before retrying."
      );
    }
    throw error instanceof Error
      ? error
      : new Error("Could not stop this task. Refresh the board and try again.");
  }
}
