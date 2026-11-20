import {
  type BoardTaskCommandResponse,
  findTaskInColumns,
  type WorkspaceBoard,
  type WorkspaceMutation,
} from "@chorus/contracts";
import type { StoreCommit } from "../../workspace/store";
import { BoardLifecycleError, BoardTaskCommandError } from "../errors";
import {
  assertBoardOpen,
  assertCheckoutAuthorized,
  type BoardTaskRuntime,
  requireBoardTask,
  withBoardOperation,
} from "../runtime";
import { boardDirectory } from "../session-directory";

const BOARD_ABORT_TIMEOUT_MS = 5000;

export class BoardTaskLifecycle {
  readonly context: BoardTaskRuntime;

  constructor(context: BoardTaskRuntime) {
    this.context = context;
  }

  assertBoardOpen(boardId: string): void {
    assertBoardOpen(this.context, boardId);
  }

  async assertCheckoutAuthorized(directory: string): Promise<void> {
    await assertCheckoutAuthorized(this.context, directory);
  }

  async removeBoard(
    mutation: Extract<WorkspaceMutation, { type: "board.remove" }>
  ): Promise<StoreCommit | null> {
    const boardId = mutation.payload.boardId;
    const existing = this.context.removals.get(boardId);
    if (existing) {
      return existing;
    }
    assertBoardOpen(this.context, boardId);
    this.context.closingBoards.add(boardId);
    const removal = withBoardOperation(this.context, boardId, async () => {
      const board = this.context.workspaceStore.getBoard(boardId);
      if (!board) {
        return this.context.workspaceStore.applyMutation(mutation);
      }
      const sessionId = board.session.sessionId;
      if (sessionId && board.session.state === "active") {
        const directory = boardDirectory(board);
        const stoppedByAbort = await this.#abortSessionAndConfirmIdle(
          sessionId,
          directory
        );
        if (stoppedByAbort) {
          this.context.watchdog?.stop(sessionId);
          await this.context.workspaceStore.updateBoardSession(boardId, {
            errorMessage:
              "The agent was stopped for board removal; this checkout was retained if removal could not finish.",
            state: "error",
          });
        }
      }
      return this.context.workspaceStore.applyMutation(mutation);
    });
    this.context.removals.set(boardId, removal);
    try {
      return await removal;
    } finally {
      if (this.context.removals.get(boardId) === removal) {
        this.context.removals.delete(boardId);
        this.context.closingBoards.delete(boardId);
      }
    }
  }

  async #abortSessionAndConfirmIdle(
    sessionId: string,
    directory: string,
    source: "removal" | "stop" = "removal"
  ): Promise<boolean> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new BoardLifecycleError(
              "board_abort_failed",
              "the agent did not confirm an abort before the timeout; the board and task were kept unchanged"
            )
          ),
        BOARD_ABORT_TIMEOUT_MS
      );
    });

    try {
      if (
        await this.context.bridge.waitForSessionIdle(sessionId, directory, 0)
      ) {
        return false;
      }

      const aborted = await Promise.race([
        this.context.bridge.abortSession(sessionId, directory),
        timeout,
      ]);
      if (!aborted) {
        if (
          await this.context.bridge.waitForSessionIdle(sessionId, directory, 0)
        ) {
          return false;
        }
        if (source === "stop") {
          throw new BoardTaskCommandError(
            "abort_not_accepted",
            "The engine did not accept the stop request. The task is still running."
          );
        }
        throw new BoardLifecycleError(
          "board_abort_failed",
          "the agent did not confirm an abort; the board and task were kept unchanged"
        );
      }

      const isIdle = await Promise.race([
        this.context.bridge.waitForSessionIdle(
          sessionId,
          directory,
          BOARD_ABORT_TIMEOUT_MS
        ),
        timeout,
      ]);
      if (!isIdle) {
        throw new BoardLifecycleError(
          "board_abort_failed",
          "the agent did not confirm an abort; the board and task were kept unchanged"
        );
      }
      return true;
    } catch (error) {
      if (
        error instanceof BoardLifecycleError ||
        error instanceof BoardTaskCommandError
      ) {
        throw error;
      }
      throw new BoardLifecycleError(
        "board_abort_failed",
        "the engine could not confirm an abort; the board and task were kept unchanged"
      );
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  abortTask(
    boardId: string,
    taskId: string
  ): Promise<BoardTaskCommandResponse> {
    assertBoardOpen(this.context, boardId);
    return withBoardOperation(this.context, boardId, async () => {
      assertBoardOpen(this.context, boardId);
      const { board, task } = requireBoardTask(this.context, boardId, taskId);
      if (
        task.outcome === "aborted" &&
        (board.columns.done ?? []).some((entry) => entry.id === taskId)
      ) {
        const sessionId =
          task.run?.sessionId ?? task.runId ?? board.session.sessionId;
        if (!sessionId) {
          throw new BoardTaskCommandError(
            "task_session_missing",
            "This task's provider session is no longer attached to the board. Refresh and try again."
          );
        }
        return {
          boardId,
          sessionId,
          status: "accepted",
          taskId,
          timestamp: Date.now(),
        };
      }
      if (
        board.session.currentTaskId !== taskId ||
        (board.columns.done ?? []).some((entry) => entry.id === taskId)
      ) {
        throw new BoardTaskCommandError(
          "task_not_abortable",
          "This task is no longer running. Refresh the board to load its latest status."
        );
      }
      const sessionId =
        task.run?.sessionId ?? task.runId ?? board.session.sessionId;
      if (
        !sessionId ||
        (board.session.sessionId && board.session.sessionId !== sessionId)
      ) {
        throw new BoardTaskCommandError(
          "task_session_missing",
          "This task's provider session is no longer attached to the board. Refresh and try again."
        );
      }

      const directory = boardDirectory(board);
      await assertCheckoutAuthorized(this.context, directory);
      await this.context.bridge.subscribeDirectory(directory);
      const stoppedByAbort = await this.#abortSessionAndConfirmIdle(
        sessionId,
        directory,
        "stop"
      );
      const timestamp = Date.now();

      if (stoppedByAbort) {
        await this.context.workspaceStore.applyBoardEventsIf(
          boardId,
          [
            {
              boardId,
              reason: "Stopped by the user.",
              taskId,
              ts: timestamp,
              type: "card.aborted",
            },
          ],
          (currentBoard) => this.#canMarkTaskAborted(currentBoard, taskId)
        );
      } else {
        await this.context.workspaceStore.applyBoardEventsIf(
          boardId,
          [
            {
              boardId,
              ts: timestamp,
              type: "session.idle",
            },
          ],
          (currentBoard) => currentBoard.session.currentTaskId === taskId
        );
      }

      this.context.watchdog?.stop(sessionId);
      return {
        boardId,
        sessionId,
        status: "accepted",
        taskId,
        timestamp: Date.now(),
      };
    });
  }

  #canMarkTaskAborted(board: WorkspaceBoard, taskId: string): boolean {
    if (board.session.currentTaskId && board.session.currentTaskId !== taskId) {
      return false;
    }
    const task = findTaskInColumns(board.columns, taskId);
    if (!task) {
      return false;
    }
    if (task.outcome === "failed" || task.outcome === "timed_out") {
      return false;
    }
    return (
      board.session.currentTaskId === taskId ||
      task.outcome === "succeeded" ||
      task.outcome === "awaiting_review"
    );
  }
}
