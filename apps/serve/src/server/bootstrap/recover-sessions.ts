import type { Logger } from "@chorus/logger";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { WorkspaceStore } from "../../workspace/store";

export async function recoverBoardSessions({
  bridge,
  logger,
  workspaceStore,
}: {
  bridge: OpenCodeBridge;
  logger: Logger;
  workspaceStore: WorkspaceStore;
}): Promise<void> {
  for (const board of workspaceStore.getSnapshot().boards) {
    const hasPendingApprovals = Object.values(board.columns)
      .flat()
      .some(
        (task) =>
          (task.pendingApprovals?.length ?? 0) > 0 ||
          task.pendingApproval !== undefined
      );
    if (
      !(
        board.session.sessionId &&
        (board.session.state === "active" || hasPendingApprovals)
      )
    ) {
      continue;
    }

    try {
      await bridge.subscribeDirectory(
        board.repo.worktree ?? board.repo.directory
      );
    } catch (error) {
      logger.warn("worktree-engine-restore-subscription-failed", {
        boardId: board.boardId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
