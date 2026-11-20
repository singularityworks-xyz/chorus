import { assertRegisteredRoot } from "../../auth/roots";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { BoardTaskService } from "../../tasks/board-task-service";
import { resolveSessionDirectory } from "../../tasks/session-directory";
import type { WorkspaceStore } from "../../workspace/store";
import type { PendingApprovalActionResult } from "../../workspace/store/pending-approvals";

type RouteBridge = Pick<
  OpenCodeBridge,
  | "abortSession"
  | "findAutocompleteFiles"
  | "getStatus"
  | "listAutocompleteCommands"
  | "listAutocompleteDirectory"
  | "listAutocompleteSkills"
  | "listQuestions"
  | "rejectQuestion"
  | "replyPermission"
  | "replyQuestion"
  | "revertSession"
  | "sessionDiff"
  | "unrevertSession"
> & {
  forkSession: (
    input: Parameters<OpenCodeBridge["forkSession"]>[0]
  ) => Promise<{ id: string }>;
  promptSession: (
    input: Parameters<OpenCodeBridge["promptSession"]>[0]
  ) => Promise<unknown>;
};

type RouteBoardTasks = Pick<
  BoardTaskService,
  | "abortTask"
  | "assertBoardOpen"
  | "assertCheckoutAuthorized"
  | "finalizeReview"
  | "getSessionHistoryState"
  | "queuePrompt"
  | "rejectReview"
  | "retryTask"
  | "runQueuedTask"
  | "sessionHistoryCommand"
>;

type RouteWorkspaceStore = Pick<
  WorkspaceStore,
  "getBoard" | "getBoardBySessionId" | "getSnapshot"
> & {
  runPendingApprovalAction: (
    sessionId: string,
    requestId: string,
    action: () => Promise<unknown>,
    options?: {
      accepts?: (value: unknown) => boolean;
      resume?: boolean;
    }
  ) => Promise<PendingApprovalActionResult<unknown>>;
  updateBoardSession: (
    boardId: string,
    update: Parameters<WorkspaceStore["updateBoardSession"]>[1]
  ) => Promise<unknown>;
};

export interface HttpRouteDependencies {
  boardTasks: RouteBoardTasks;
  bridge: RouteBridge;
  workspaceStore: RouteWorkspaceStore;
}

export function createSessionDirectoryResolver(
  workspaceStore: Pick<WorkspaceStore, "getBoardBySessionId">,
  boardTasks: Pick<
    BoardTaskService,
    "assertBoardOpen" | "assertCheckoutAuthorized"
  >
) {
  return async (sessionID: string): Promise<string> => {
    const board = workspaceStore.getBoardBySessionId(sessionID);
    if (board) {
      boardTasks.assertBoardOpen(board.boardId);
    }
    const directory = resolveSessionDirectory(workspaceStore, sessionID);
    await boardTasks.assertCheckoutAuthorized(directory);
    return directory;
  };
}

export async function resolveBoardDirectory(
  workspaceStore: Pick<WorkspaceStore, "getSnapshot">,
  boardTasks: Pick<BoardTaskService, "assertCheckoutAuthorized">,
  directory: string
): Promise<string> {
  const resolved = assertRegisteredRoot(
    directory,
    workspaceStore.getSnapshot().boards
  );
  await boardTasks.assertCheckoutAuthorized(resolved);
  return resolved;
}
