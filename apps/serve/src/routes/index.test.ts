import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
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
    replyPermission: mock(async () => true),
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
        speechVoiceId: null,
      },
      previousWorkspaces: [],
      revision: 1,
      selectedBoardId: null,
    })),
    queuePrompt: mock(async (input: unknown) => ({
      boardId: (input as { boardId: string }).boardId,
      sessionId: "sess-123",
      createdSession: true,
      accepted: true,
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
        } as never
      )
    );
    return { app, bridge, boardTasks };
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
      const { app, bridge } = makeApp();

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
