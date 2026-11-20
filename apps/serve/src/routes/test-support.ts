import { mock } from "bun:test";

import type { WorkspaceBoard } from "@chorus/contracts";
import { Elysia } from "elysia";
import type { PendingApprovalActionResult } from "../workspace/store/pending-approvals";
import { createHttpRoutes } from "./index";
import type { HttpRouteDependencies } from "./shared/dependencies";

function makeMockBridge() {
  return {
    abortSession: mock(async () => true),
    findAutocompleteFiles: mock(async () => [
      { path: "src/main.ts", type: "file" as const },
    ]),
    forkSession: mock(async () => ({ id: "sess-forked" })),
    getStatus: mock(() => ({
      connected: true,
      opencodeUrl: "http://localhost:4096",
      activeSessions: 2,
      subscribedDirectories: ["/repo"],
      uptime: 1000,
    })),
    listAutocompleteCommands: mock(async () => [
      { name: "review", description: "Review changes" },
    ]),
    listAutocompleteDirectory: mock(async () => [
      { path: "src/test", type: "directory" as const },
    ]),
    listAutocompleteSkills: mock(async () => [
      { name: "typescript", description: "TypeScript" },
    ]),
    listQuestions: mock(async () => []),
    promptSession: mock(async () => ({})),
    rejectQuestion: mock(async () => true),
    replyPermission: mock(async () => true),
    replyQuestion: mock(async () => true),
    sessionDiff: mock(async () => [
      {
        additions: 1,
        after: "new\n",
        before: "old\n",
        deletions: 1,
        file: "src/main.ts",
      },
    ]),
    revertSession: mock(() => {
      throw new Error("revertSession is not configured in this fixture");
    }),
    unrevertSession: mock(() => {
      throw new Error("unrevertSession is not configured in this fixture");
    }),
  } satisfies HttpRouteDependencies["bridge"];
}

function makeMockBoardTasks() {
  return {
    assertCheckoutAuthorized: mock(async () => undefined),
    assertBoardOpen: mock(() => undefined),
    queuePrompt: mock(
      async (
        input: Parameters<HttpRouteDependencies["boardTasks"]["queuePrompt"]>[0]
      ) => ({
        boardId: input.boardId,
        sessionId: "sess-123",
        taskId: "task-123",
        createdSession: true,
        accepted: true,
        timestamp: 123,
      })
    ),
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
    finalizeReview: mock(async (boardId, taskId) => ({
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
  } satisfies HttpRouteDependencies["boardTasks"];
}

const BOARD_WORKTREE = "/repo/.chorus-worktrees/board-1";

function makeBoard(sessionId: string): WorkspaceBoard {
  return {
    boardId: "board-1",
    title: "Repo",
    repo: { directory: "/repo", worktree: BOARD_WORKTREE, sandboxes: [] },
    position: { x: 0, y: 0 },
    columns: { queue: [], in_progress: [], approve: [], done: [] },
    reviewMode: "auto",
    modelSelection: null,
    session: { currentTaskId: "task-1", sessionId, state: "active" },
  };
}

function makeApp() {
  const bridge = makeMockBridge();
  const boardTasks = makeMockBoardTasks();
  const updateBoardSession = mock(async () => null);
  const resolvePendingApproval = mock(
    async (_sessionID: string, _requestID: string, _resume: boolean) => false
  );
  async function runPendingApprovalAction(
    sessionID: string,
    requestID: string,
    action: () => Promise<unknown>,
    options?: {
      accepts?: (value: unknown) => boolean;
      resume?: boolean;
    }
  ): Promise<PendingApprovalActionResult<unknown>> {
    const value = await action();
    if (options?.accepts && !options.accepts(value)) {
      return { status: "rejected" };
    }
    await resolvePendingApproval(
      sessionID,
      requestID,
      options?.resume ?? false
    );
    return { status: "accepted", value };
  }
  const runPendingApprovalActionMock = mock(runPendingApprovalAction);
  const workspaceStore: HttpRouteDependencies["workspaceStore"] = {
    getBoard: mock((boardId: string) =>
      boardId === "board-1" ? makeBoard("sess-123") : undefined
    ),
    getBoardBySessionId: mock((sessionID: string) =>
      sessionID === "sess-1" || sessionID === "sess-123"
        ? makeBoard(sessionID)
        : undefined
    ),
    getSnapshot: mock(() => ({
      boards: [],
      preferences: {
        boardViewMode: "relaxed" as const,
        composerHintDismissed: false,
        defaultModelSelection: null,
        recentlyUsedModels: [],
        speechVoiceId: null,
      },
      previousWorkspaces: [],
      revision: 1,
      selectedBoardId: null,
    })),
    runPendingApprovalAction: runPendingApprovalActionMock,
    updateBoardSession,
  };
  const app = new Elysia().use(
    createHttpRoutes(bridge, boardTasks, workspaceStore)
  );
  return {
    app,
    bridge,
    boardTasks,
    resolvePendingApproval,
    runPendingApprovalAction: runPendingApprovalActionMock,
    updateBoardSession,
  };
}

export { BOARD_WORKTREE, makeApp };
