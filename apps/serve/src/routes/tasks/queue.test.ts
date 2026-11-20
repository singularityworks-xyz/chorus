import { describe, expect, test } from "bun:test";
import { GlobalModelNotConfiguredError } from "../../tasks/errors";
import { makeApp } from "../test-support";

describe("POST /tasks", () => {
  test("queues a board-aware prompt", async () => {
    const { app, boardTasks } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          boardId: "board-1",
          directory: "/tmp/repo",
          text: "build a feature",
        }),
      })
    );

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      boardId: "board-1",
      sessionId: "sess-123",
      taskId: "task-123",
      createdSession: true,
      accepted: true,
      timestamp: 123,
    });

    expect(boardTasks.queuePrompt).toHaveBeenCalledWith({
      boardId: "board-1",
      directory: "/tmp/repo",
      reviewMode: "auto",
      text: "build a feature",
    });
  });

  test("passes model and agent when provided", async () => {
    const { app, boardTasks } = makeApp();

    await app.handle(
      new Request("http://localhost/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          boardId: "board-1",
          directory: "/tmp/repo",
          text: "do work",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
          agent: "build",
        }),
      })
    );

    expect(boardTasks.queuePrompt).toHaveBeenCalledWith({
      boardId: "board-1",
      directory: "/tmp/repo",
      reviewMode: "auto",
      text: "do work",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      agent: "build",
    });
  });

  test("rejects missing text", async () => {
    const { app } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          boardId: "board-1",
          directory: "/tmp/repo",
        }),
      })
    );

    expect(res.status).toBe(422);
  });

  test("returns a recoverable conflict when the global model is missing", async () => {
    const { app, boardTasks } = makeApp();
    boardTasks.queuePrompt.mockRejectedValue(
      new GlobalModelNotConfiguredError()
    );

    const response = await app.handle(
      new Request("http://localhost/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          boardId: "board-1",
          directory: "/tmp/repo",
          text: "build a feature",
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "global_model_not_configured",
      message:
        "Choose one provider and model in Settings before starting a task.",
    });
  });
});
