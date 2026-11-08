import { describe, expect, test } from "bun:test";
import { requestBoardTaskCommand } from "./task-command-client";

function acceptedResponse({
  boardId = "board-1",
  status = "accepted",
  taskId = "task-1",
}: {
  boardId?: string;
  status?: "accepted" | "already_running";
  taskId?: string;
} = {}) {
  return new Response(
    JSON.stringify({
      boardId,
      sessionId: "session-1",
      status,
      taskId,
      timestamp: 1,
    }),
    { status: 200 }
  );
}

describe("board task command client", () => {
  test("targets the owning board and task with a bounded request", async () => {
    let requestUrl = "";
    let requestSignal: AbortSignal | null | undefined;
    const response = await requestBoardTaskCommand(
      "board with spaces",
      "task/one",
      "run",
      (input, init) => {
        requestUrl = input instanceof Request ? input.url : String(input);
        requestSignal = init?.signal;
        return Promise.resolve(
          acceptedResponse({
            boardId: "board with spaces",
            taskId: "task/one",
          })
        );
      }
    );

    expect(requestUrl).toBe(
      "/api/boards/board%20with%20spaces/tasks/task%2Fone/run"
    );
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(response.status).toBe("accepted");
  });

  test("rejects acknowledgments for a different board or task", async () => {
    for (const response of [
      acceptedResponse({ boardId: "board-2" }),
      acceptedResponse({ taskId: "task-2" }),
    ]) {
      await expect(
        requestBoardTaskCommand("board-1", "task-1", "retry", () =>
          Promise.resolve(response)
        )
      ).rejects.toThrow("did not confirm this task");
    }
  });

  test("preserves a safe server error message", async () => {
    await expect(
      requestBoardTaskCommand(
        "board-1",
        "task-1",
        "run",
        async () =>
          new Response(
            JSON.stringify({
              code: "board_busy",
              message: "Another task is running.",
            }),
            { status: 409 }
          )
      )
    ).rejects.toThrow("Another task is running.");
  });

  test("turns timeouts and network failures into recovery guidance", async () => {
    await expect(
      requestBoardTaskCommand("board-1", "task-1", "retry", () =>
        Promise.reject(new DOMException("Timed out", "TimeoutError"))
      )
    ).rejects.toThrow("Refresh the board to check whether it started");

    await expect(
      requestBoardTaskCommand("board-1", "task-1", "run", () =>
        Promise.reject(new TypeError("Failed to fetch"))
      )
    ).rejects.toThrow("Could not reach Chorus");
  });
});
