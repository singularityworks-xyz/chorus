import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import {
  BoardTaskCommandError,
  GlobalModelNotConfiguredError,
} from "../tasks/board-task-service";
import { createHttpRoutes } from "./index";

function makeMockBridge() {
  return {
    adapter: {
      sessions: {
        fork: mock(async () => ({ id: "sess-forked" })),
      },
    },
    createSession: mock(async () => ({ id: "sess-123" })),
    promptSession: mock(async () => ({})),
    abortSession: mock(async () => true),
    sessionDiff: mock(async () => [
      {
        additions: 1,
        after: "new\n",
        before: "old\n",
        deletions: 1,
        file: "src/main.ts",
      },
    ]),
    replyPermission: mock(async () => true),
    replyQuestion: mock(async () => undefined),
    rejectQuestion: mock(async () => undefined),
    listQuestions: mock(async () => []),
    forkSession: mock(async () => ({ id: "sess-forked" })),
    getStatus: mock(() => ({
      connected: true,
      opencodeUrl: "http://localhost:4096",
      activeSessions: 2,
      uptime: 1000,
    })),
  };
}

function makeMockBoardTasks() {
  return {
    getWorkspaceSnapshot: mock(() => ({
      boards: [],
      preferences: {
        composerHintDismissed: false,
        defaultModelSelection: null,
        speechVoiceId: null,
      },
      previousWorkspaces: [],
      revision: 1,
      selectedBoardId: null,
    })),
    assertCheckoutAuthorized: mock(async (directory: string) => directory),
    assertBoardOpen: mock(() => undefined),
    queuePrompt: mock(async (input: unknown) => ({
      boardId: (input as { boardId: string }).boardId,
      sessionId: "sess-123",
      taskId: "task-123",
      createdSession: true,
      accepted: true,
      timestamp: 123,
    })),
    runQueuedTask: mock(async (boardId: string, taskId: string) => ({
      boardId,
      sessionId: "sess-123",
      status: "accepted" as const,
      taskId,
      timestamp: 123,
    })),
    retryTask: mock(async (boardId: string, taskId: string) => ({
      boardId,
      sessionId: "sess-123",
      status: "accepted" as const,
      taskId,
      timestamp: 123,
    })),
    finalizeReview: mock(async (boardId: string, taskId: string) => ({
      boardId,
      sessionId: "sess-123",
      status: "accepted" as const,
      taskId,
      timestamp: 123,
    })),
    rejectReview: mock(async (boardId: string, taskId: string) => ({
      accepted: true as const,
      boardId,
      taskId,
      timestamp: 123,
    })),
  };
}

describe("HTTP routes", () => {
  /** The worktree a seeded board owns, so tests can prove it is the one used. */
  const BOARD_WORKTREE = "/repo/.chorus-worktrees/board-1";

  function makeApp() {
    const bridge = makeMockBridge();
    const boardTasks = makeMockBoardTasks();
    const updateBoardSession = mock(async () => undefined);
    const app = new Elysia().use(
      createHttpRoutes(
        bridge as never,
        boardTasks as never,
        // The store backs the registered-root check on the git/snapshot routes,
        // and resolves the checkout a follow-up command runs against. A session it
        // cannot place is refused rather than silently defaulted.
        {
          getBoardBySessionId: (sessionID: string) =>
            sessionID === "sess-1" || sessionID === "sess-123"
              ? {
                  boardId: "board-1",
                  repo: { directory: "/repo", worktree: BOARD_WORKTREE },
                }
              : undefined,
          getSnapshot: () => ({ boards: [] }),
          resolvePendingApproval: async () => false,
          updateBoardSession,
        } as never
      )
    );
    return { app, bridge, boardTasks, updateBoardSession };
  }

  describe("GET /health", () => {
    test("returns ok status with timestamp", async () => {
      const { app } = makeApp();

      const res = await app.handle(new Request("http://localhost/health"));

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        status: "ok",
        timestamp: expect.any(Number),
      });
    });
  });

  describe("GET /bridge/status", () => {
    test("returns bridge status", async () => {
      const { app } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/bridge/status")
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        connected: true,
        opencodeUrl: "http://localhost:4096",
        activeSessions: 2,
        uptime: 1000,
      });
    });
  });

  describe("GET /sessions/:sessionID/diff", () => {
    test("reads the session diff from the board's authorized checkout", async () => {
      const { app, bridge } = makeApp();

      const response = await app.handle(
        new Request("http://localhost/sessions/sess-1/diff")
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        {
          additions: 1,
          after: "new\n",
          before: "old\n",
          deletions: 1,
          file: "src/main.ts",
        },
      ]);
      expect(bridge.sessionDiff).toHaveBeenCalledWith("sess-1", BOARD_WORKTREE);
    });

    test("rejects a session that has no owning board", async () => {
      const { app, bridge } = makeApp();

      const response = await app.handle(
        new Request("http://localhost/sessions/unknown/diff")
      );

      expect(response.status).toBe(404);
      expect(bridge.sessionDiff).not.toHaveBeenCalled();
    });
  });

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

  describe("POST /tasks/:sessionID/approve", () => {
    test("approves a permission request", async () => {
      const { app, bridge } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-1/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestID: "perm-1" }),
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        sessionID: "sess-1",
        requestID: "perm-1",
        accepted: true,
        timestamp: expect.any(Number),
      });

      expect(bridge.replyPermission).toHaveBeenCalledWith({
        directory: BOARD_WORKTREE,
        requestID: "perm-1",
        sessionID: "sess-1",
        reply: "once",
        message: undefined,
      });
    });

    test("passes optional message", async () => {
      const { app, bridge } = makeApp();

      await app.handle(
        new Request("http://localhost/tasks/sess-1/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestID: "perm-1", message: "approved" }),
        })
      );

      expect(bridge.replyPermission).toHaveBeenCalledWith({
        directory: BOARD_WORKTREE,
        requestID: "perm-1",
        sessionID: "sess-1",
        reply: "once",
        message: "approved",
      });
    });

    test("rejects missing requestID", async () => {
      const { app } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-1/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      );

      expect(res.status).toBe(422);
    });
  });

  describe("board task commands", () => {
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
      expect(boardTasks.runQueuedTask).toHaveBeenCalledWith(
        "board-1",
        "task-1"
      );
      expect(boardTasks.retryTask).toHaveBeenCalledWith("board-1", "task-2");
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

  describe("POST /tasks/:sessionID/reject", () => {
    test("rejects a permission request", async () => {
      const { app, bridge } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-1/reject", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestID: "perm-1" }),
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        sessionID: "sess-1",
        requestID: "perm-1",
        accepted: true,
        timestamp: expect.any(Number),
      });

      expect(bridge.replyPermission).toHaveBeenCalledWith({
        requestID: "perm-1",
        directory: BOARD_WORKTREE,
        sessionID: "sess-1",
        reply: "reject",
        message: undefined,
      });
    });
  });

  describe("question commands", () => {
    test("answers a question with an explicit accepted acknowledgment", async () => {
      const { app, bridge } = makeApp();

      const response = await app.handle(
        new Request(
          "http://localhost/tasks/sess-1/questions/question-1/reply",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              answers: [
                { questionIndex: 0, optionIndices: [1], customAnswer: "" },
              ],
            }),
          }
        )
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        accepted: true,
        requestID: "question-1",
        sessionID: "sess-1",
        timestamp: expect.any(Number),
      });
      expect(bridge.replyQuestion).toHaveBeenCalledWith({
        answers: [{ questionIndex: 0, optionIndices: [1], customAnswer: "" }],
        directory: BOARD_WORKTREE,
        requestID: "question-1",
      });
    });

    test("rejects a question with an explicit accepted acknowledgment", async () => {
      const { app, bridge } = makeApp();

      const response = await app.handle(
        new Request(
          "http://localhost/tasks/sess-1/questions/question-1/reject",
          { method: "POST" }
        )
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        accepted: true,
        requestID: "question-1",
        sessionID: "sess-1",
        timestamp: expect.any(Number),
      });
      expect(bridge.rejectQuestion).toHaveBeenCalledWith(
        "question-1",
        BOARD_WORKTREE
      );
    });
  });

  describe("POST /tasks/:sessionID/abort", () => {
    test("aborts a running session", async () => {
      const { app, bridge } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-1/abort", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        sessionID: "sess-1",
        accepted: true,
        timestamp: expect.any(Number),
      });

      expect(bridge.abortSession).toHaveBeenCalledWith(
        "sess-1",
        BOARD_WORKTREE
      );
    });

    test("refuses a session no board owns", async () => {
      // The directory for a follow-up command comes from the board, so a session
      // the server cannot place has no safe directory. Falling back to the one
      // serve was started in is how a command lands in the wrong checkout.
      const { app, bridge } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-unknown/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestID: "perm-1" }),
        })
      );

      // A lookup miss, not a server fault. Letting it default to 500 hid the
      // actionable message from anything keying on status.
      expect(res.status).toBe(404);
      expect(bridge.replyPermission).not.toHaveBeenCalled();
    });

    test("rejects missing sessionID param", async () => {
      const { app } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks//abort", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      );

      expect(res.status).toBe(404);
    });
  });

  describe("POST /tasks/:sessionID/redirect", () => {
    test("soft redirect prompts the same session", async () => {
      const { app, bridge } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-1/redirect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "change approach", mode: "soft" }),
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        sessionID: "sess-1",
        mode: "soft",
        timestamp: expect.any(Number),
      });

      expect(bridge.promptSession).toHaveBeenCalledWith({
        directory: BOARD_WORKTREE,
        sessionID: "sess-1",
        text: "Redirect instruction: change approach",
      });
    });

    test("hard redirect forks the session", async () => {
      const { app, bridge, updateBoardSession } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-1/redirect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "start fresh", mode: "hard" }),
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        originalSessionID: "sess-1",
        newSessionID: "sess-forked",
        mode: "hard",
        timestamp: expect.any(Number),
      });

      expect(bridge.forkSession).toHaveBeenCalledWith({
        directory: BOARD_WORKTREE,
        sessionID: "sess-1",
      });

      expect(bridge.promptSession).toHaveBeenCalledWith({
        directory: BOARD_WORKTREE,
        sessionID: "sess-forked",
        text: "start fresh",
      });

      // The fork becomes the board's session, or every later command for it fails
      // as unknown and its agent events have no board.
      expect(updateBoardSession).toHaveBeenCalledWith("board-1", {
        sessionId: "sess-forked",
        state: "active",
      });
    });

    test("rejects invalid mode", async () => {
      const { app } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-1/redirect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "test", mode: "invalid" }),
        })
      );

      expect(res.status).toBe(422);
    });

    test("rejects missing text", async () => {
      const { app } = makeApp();

      const res = await app.handle(
        new Request("http://localhost/tasks/sess-1/redirect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "soft" }),
        })
      );

      expect(res.status).toBe(422);
    });
  });
});
