import type {
  BoardSessionHistoryCommand,
  BoardSessionHistoryCommandResponse,
  BoardSessionHistoryState,
  WorkspaceBoard,
} from "@chorus/contracts";
import { BoardTaskCommandError, SessionOwnershipError } from "../errors";
import { taskLogger as logger } from "../logger";
import {
  assertBoardOpen,
  assertCheckoutAuthorized,
  type BoardTaskRuntime,
  hasLiveTask,
  sameDirectory,
  withBoardOperation,
} from "../runtime";
import { boardDirectory } from "../session-directory";

export class BoardSessionHistory {
  readonly context: BoardTaskRuntime;

  constructor(context: BoardTaskRuntime) {
    this.context = context;
  }

  getSessionHistoryState(boardId: string): Promise<BoardSessionHistoryState> {
    assertBoardOpen(this.context, boardId);
    return withBoardOperation(this.context, boardId, async () => {
      assertBoardOpen(this.context, boardId);
      const board = this.context.workspaceStore.getBoard(boardId);
      if (!board) {
        throw new BoardTaskCommandError(
          "board_not_found",
          "This board no longer exists. Refresh the workspace and try again."
        );
      }

      const history = await this.#loadSessionHistory(board);
      return {
        boardId,
        canRedo: history.canRedo,
        canUndo: history.canUndo,
        busy: history.busy,
        sessionId: history.sessionId,
        timestamp: Date.now(),
      };
    });
  }

  sessionHistoryCommand(
    boardId: string,
    command: BoardSessionHistoryCommand
  ): Promise<BoardSessionHistoryCommandResponse> {
    assertBoardOpen(this.context, boardId);
    return withBoardOperation(this.context, boardId, async () => {
      assertBoardOpen(this.context, boardId);
      const board = this.context.workspaceStore.getBoard(boardId);
      if (!board) {
        throw new BoardTaskCommandError(
          "board_not_found",
          "This board no longer exists. Refresh the workspace and try again."
        );
      }

      const history = await this.#loadSessionHistory(board);
      if (!history.sessionId) {
        throw new BoardTaskCommandError(
          "session_not_available",
          "This board does not have an OpenCode session to undo or redo."
        );
      }
      if (history.busy) {
        throw new BoardTaskCommandError(
          "session_busy",
          "Wait for the board's current work to finish before changing repository history."
        );
      }
      if (command === "undo" && !history.canUndo) {
        throw new BoardTaskCommandError(
          "session_nothing_to_undo",
          "There are no repository changes to undo in this board's session."
        );
      }
      if (command === "redo" && !history.canRedo) {
        throw new BoardTaskCommandError(
          "session_nothing_to_redo",
          "There are no undone repository changes to redo in this board's session."
        );
      }

      const directory = boardDirectory(board);
      try {
        if (command === "undo") {
          await this.context.bridge.revertSession(history.sessionId, directory);
        } else {
          await this.context.bridge.unrevertSession(
            history.sessionId,
            directory
          );
        }
      } catch (error) {
        logger.error("session-history-command-failed", error, {
          boardId,
          command,
          sessionId: history.sessionId,
        });
        throw new BoardTaskCommandError(
          "session_command_failed",
          `Could not confirm the ${command} operation. Refresh repository history before trying again.`
        );
      }

      return {
        accepted: true,
        boardId,
        command,
        sessionId: history.sessionId,
        timestamp: Date.now(),
      };
    });
  }

  async #loadSessionHistory(board: WorkspaceBoard): Promise<{
    busy: boolean;
    canRedo: boolean;
    canUndo: boolean;
    sessionId: string | null;
  }> {
    const sessionId = board.session.sessionId ?? null;
    const boardId = board.boardId;
    const directory = boardDirectory(board);
    const currentTaskId = board.session.currentTaskId;
    const currentTaskIsUnfinished =
      currentTaskId !== undefined &&
      !(board.columns.done ?? []).some((task) => task.id === currentTaskId);
    const busyFromBoard =
      board.session.state === "starting" ||
      currentTaskIsUnfinished ||
      hasLiveTask(board);

    if (!sessionId) {
      return { busy: busyFromBoard, canRedo: false, canUndo: false, sessionId };
    }

    await assertCheckoutAuthorized(this.context, directory);

    try {
      if (busyFromBoard) {
        return { busy: true, canRedo: false, canUndo: false, sessionId };
      }
      const idle = await this.context.bridge.waitForSessionIdle(
        sessionId,
        directory,
        0
      );
      if (!idle) {
        return { busy: true, canRedo: false, canUndo: false, sessionId };
      }

      const session = await this.context.bridge.getSession({
        engineDirectory: directory,
        sessionID: sessionId,
      });
      if (!session.directory) {
        throw new SessionOwnershipError(
          "session_directory_unknown",
          "The engine could not verify this board's session directory."
        );
      }
      if (!sameDirectory(session.directory, directory)) {
        throw new SessionOwnershipError(
          "session_ownership_conflict",
          "This session belongs to a different checkout and cannot change this board's repository history."
        );
      }

      const messages = await this.context.bridge.sessionMessages(
        sessionId,
        directory
      );
      return {
        busy: false,
        canRedo: Boolean(session.revert),
        canUndo:
          !session.revert &&
          messages.some((message) => message.info.role === "user"),
        sessionId,
      };
    } catch (error) {
      if (
        error instanceof BoardTaskCommandError ||
        error instanceof SessionOwnershipError
      ) {
        throw error;
      }
      logger.warn("session-history-state-unavailable", {
        boardId,
        errorName: error instanceof Error ? error.name : "unknown",
        sessionId,
      });
      throw new BoardTaskCommandError(
        "session_history_unavailable",
        "Could not load repository history for this board. Refresh the board and retry."
      );
    }
  }
}
