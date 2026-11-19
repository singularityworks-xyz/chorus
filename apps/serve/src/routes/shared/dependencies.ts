import { assertRegisteredRoot } from "../../auth/roots";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { BoardTaskService } from "../../tasks/board-task-service";
import { resolveSessionDirectory } from "../../tasks/session-directory";
import type { WorkspaceStore } from "../../workspace/store";

export interface HttpRouteDependencies {
  boardTasks: BoardTaskService;
  bridge: OpenCodeBridge;
  workspaceStore: WorkspaceStore;
}

export function createSessionDirectoryResolver(
  workspaceStore: WorkspaceStore,
  boardTasks: BoardTaskService
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
  workspaceStore: WorkspaceStore,
  boardTasks: BoardTaskService,
  directory: string
): Promise<string> {
  const resolved = assertRegisteredRoot(
    directory,
    workspaceStore.getSnapshot().boards
  );
  await boardTasks.assertCheckoutAuthorized(resolved);
  return resolved;
}
