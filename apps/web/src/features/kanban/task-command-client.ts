import {
  apiErrorSchema,
  boardTaskCommandResponseSchema,
} from "@chorus/contracts";

export type BoardTaskAction = "run" | "retry";

const BOARD_TASK_COMMAND_TIMEOUT_MS = 10_000;
type TaskCommandFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export async function requestBoardTaskCommand(
  boardId: string,
  taskId: string,
  action: BoardTaskAction,
  fetcher: TaskCommandFetch = fetch
) {
  try {
    const response = await fetcher(
      `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(BOARD_TASK_COMMAND_TIMEOUT_MS),
      }
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(payload);
      throw new Error(
        error.success
          ? error.data.message
          : `Could not ${action} this task. Try again.`
      );
    }

    const command = boardTaskCommandResponseSchema.safeParse(payload);
    if (
      !command.success ||
      command.data.boardId !== boardId ||
      (action === "run" && command.data.taskId !== taskId) ||
      (action === "retry" &&
        (command.data.taskId === taskId || command.data.retryOf !== taskId))
    ) {
      throw new Error(
        "The server response did not confirm this task. Refresh the board before trying again."
      );
    }
    return command.data;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        "The task command timed out. Refresh the board to check whether it started before retrying."
      );
    }
    if (error instanceof TypeError) {
      throw new Error(
        "Could not reach Chorus. Check the connection and refresh the board before retrying."
      );
    }
    throw error;
  }
}
