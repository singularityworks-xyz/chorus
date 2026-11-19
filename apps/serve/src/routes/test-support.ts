import { mock } from "bun:test";

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
    sessionDiff: mock(async () => [
      {
        additions: 1,
        after: "new\n",
        before: "old\n",
        deletions: 1,
        file: "src/main.ts",
      },
    ]),
    listAutocompleteCommands: mock(async () => [
      { name: "review", description: "Review changes" },
    ]),
    listAutocompleteSkills: mock(async () => [
      { name: "typescript", description: "TypeScript" },
    ]),
    findAutocompleteFiles: mock(async () => [
      { path: "src/main.ts", type: "file" as const },
    ]),
    listAutocompleteDirectory: mock(async () => [
      { path: "src/test", type: "directory" as const },
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
    queuePrompt: mock(async (input: { boardId: string }) => ({
      boardId: input.boardId,
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
    abortTask: mock(async (boardId: string, taskId: string) => ({
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
    getSessionHistoryState: mock(async (boardId: string) => ({
      boardId,
      canRedo: false,
      canUndo: true,
      busy: false,
      sessionId: "sess-123",
      timestamp: 123,
    })),
    sessionHistoryCommand: mock(
      async (boardId: string, command: "undo" | "redo") => ({
        accepted: true as const,
        boardId,
        command,
        sessionId: "sess-123",
        timestamp: 123,
      })
    ),
  };
}

const BOARD_WORKTREE = "/repo/.chorus-worktrees/board-1";

function makeApp() {
  const bridge = makeMockBridge();
  const boardTasks = makeMockBoardTasks();
  const updateBoardSession = mock(async () => undefined);
  const resolvePendingApproval = mock(
    async (_sessionID: string, _requestID: string, _resume: boolean) => false
  );
  const runPendingApprovalAction = mock(
    async (
      sessionID: string,
      requestID: string,
      action: () => Promise<unknown>,
      options?: {
        accepts?: (value: unknown) => boolean;
        resume?: boolean;
      }
    ): Promise<
      | { status: "accepted"; value: unknown }
      | { status: "already_resolving" }
      | { status: "not_pending" }
      | { status: "rejected" }
    > => {
      const value = await action();
      if (options?.accepts && !options.accepts(value)) {
        return { status: "rejected" as const };
      }
      await resolvePendingApproval(
        sessionID,
        requestID,
        options?.resume ?? false
      );
      return { status: "accepted" as const, value };
    }
  );
  const app = new Elysia().use(
    createHttpRoutes(
      bridge as never,
      boardTasks as never,

      {
        getBoard: (boardId: string) =>
          boardId === "board-1"
            ? {
                boardId,
                repo: { directory: "/repo", worktree: BOARD_WORKTREE },
                session: { currentTaskId: "task-1", sessionId: "sess-123" },
              }
            : undefined,
        getBoardBySessionId: (sessionID: string) =>
          sessionID === "sess-1" || sessionID === "sess-123"
            ? {
                boardId: "board-1",
                repo: { directory: "/repo", worktree: BOARD_WORKTREE },
                session: { currentTaskId: "task-1", sessionId: sessionID },
              }
            : undefined,
        getSnapshot: () => ({ boards: [] }),
        resolvePendingApproval,
        runPendingApprovalAction,
        updateBoardSession,
      } as never
    )
  );
  return {
    app,
    bridge,
    boardTasks,
    resolvePendingApproval,
    runPendingApprovalAction,
    updateBoardSession,
  };
}

export { BOARD_WORKTREE, makeApp };
