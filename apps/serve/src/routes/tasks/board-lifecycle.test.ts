import { describe, expect, test } from "bun:test";
import { BoardTaskCommandError } from "../../tasks/errors";
import { makeApp } from "../test-support";

describe("board task commands", () => {
  test("reads and changes history through the explicit board session", async () => {
    const { app, boardTasks } = makeApp();

    const stateResponse = await app.handle(
      new Request("http://localhost/boards/board-1/session/history")
    );
    const commandResponse = await app.handle(
      new Request("http://localhost/boards/board-1/session/history/undo", {
        method: "POST",
      })
    );

    expect(stateResponse.status).toBe(200);
    expect(await stateResponse.json()).toMatchObject({
      boardId: "board-1",
      canUndo: true,
      canRedo: false,
    });
    expect(boardTasks.getSessionHistoryState).toHaveBeenCalledWith("board-1");
    expect(commandResponse.status).toBe(200);
    expect(await commandResponse.json()).toMatchObject({
      accepted: true,
      boardId: "board-1",
      command: "undo",
    });
    expect(boardTasks.sessionHistoryCommand).toHaveBeenCalledWith(
      "board-1",
      "undo"
    );
  });

  test("rejects unsupported board session history commands", async () => {
    const { app, boardTasks } = makeApp();

    const response = await app.handle(
      new Request("http://localhost/boards/board-1/session/history/reset", {
        method: "POST",
      })
    );

    expect(response.status).toBe(422);
    expect(boardTasks.sessionHistoryCommand).not.toHaveBeenCalled();
  });

  test("maps session history failures to actionable HTTP errors", async () => {
    const { app, boardTasks } = makeApp();
    boardTasks.getSessionHistoryState.mockRejectedValue(
      new BoardTaskCommandError(
        "session_history_unavailable",
        "Could not load repository history for this board. Refresh the board and retry."
      )
    );
    boardTasks.sessionHistoryCommand.mockRejectedValue(
      new BoardTaskCommandError(
        "session_command_failed",
        "Refresh repository history before trying again."
      )
    );

    const stateResponse = await app.handle(
      new Request("http://localhost/boards/board-1/session/history")
    );
    const commandResponse = await app.handle(
      new Request("http://localhost/boards/board-1/session/history/undo", {
        method: "POST",
      })
    );

    expect(stateResponse.status).toBe(503);
    expect(await stateResponse.json()).toEqual({
      code: "session_history_unavailable",
      message:
        "Could not load repository history for this board. Refresh the board and retry.",
    });
    expect(commandResponse.status).toBe(502);
    expect(await commandResponse.json()).toEqual({
      code: "session_command_failed",
      message: "Refresh repository history before trying again.",
    });
  });

  test("routes Run and Retry with explicit board and task identities", async () => {
    const { app, boardTasks } = makeApp();

    const runResponse = await app.handle(
      new Request("http://localhost/boards/board-1/tasks/task-1/run", {
        method: "POST",
      })
    );
    const retryResponse = await app.handle(
      new Request("http://localhost/boards/board-1/tasks/task-2/retry", {
        method: "POST",
      })
    );

    expect(runResponse.status).toBe(200);
    expect(retryResponse.status).toBe(200);
    expect(boardTasks.runQueuedTask).toHaveBeenCalledWith("board-1", "task-1");
    expect(boardTasks.retryTask).toHaveBeenCalledWith("board-1", "task-2");
  });

  test("routes Stop with explicit board and task identities", async () => {
    const { app, boardTasks } = makeApp();

    const response = await app.handle(
      new Request("http://localhost/boards/board-1/tasks/task-5/abort", {
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(boardTasks.abortTask).toHaveBeenCalledWith("board-1", "task-5");
  });

  test("routes plan finalize and reject with explicit board and task identities", async () => {
    const { app, boardTasks } = makeApp();
    const payload = { answers: ["Use the safer option"], plan: "step one" };

    const finalizeResponse = await app.handle(
      new Request(
        "http://localhost/boards/board-1/tasks/task-3/finalize-review",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }
      )
    );
    const rejectResponse = await app.handle(
      new Request(
        "http://localhost/boards/board-1/tasks/task-4/reject-review",
        { method: "POST" }
      )
    );

    expect(finalizeResponse.status).toBe(200);
    expect(await finalizeResponse.json()).toMatchObject({ accepted: true });
    expect(boardTasks.finalizeReview).toHaveBeenCalledWith(
      "board-1",
      "task-3",
      payload
    );
    expect(rejectResponse.status).toBe(200);
    expect(boardTasks.rejectReview).toHaveBeenCalledWith("board-1", "task-4");
  });

  test("returns a recoverable conflict when another task is active", async () => {
    const { app, boardTasks } = makeApp();
    boardTasks.runQueuedTask.mockRejectedValue(
      new BoardTaskCommandError("board_busy", "This board is busy.")
    );

    const response = await app.handle(
      new Request("http://localhost/boards/board-1/tasks/task-1/run", {
        method: "POST",
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "board_busy",
      message: "This board is busy.",
    });
  });
});
