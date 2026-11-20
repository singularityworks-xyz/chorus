import type {
  BoardTaskCommandResponse,
  BoardTaskFinalizeReviewInput,
  ModelSelection,
  Task,
  WorkspaceBoard,
} from "@chorus/contracts";
import {
  boardTaskFinalizeReviewInputSchema,
  findTaskInColumns,
} from "@chorus/contracts";
import type { StoreCommit } from "../../workspace/store";
import { BoardTaskCommandError } from "../errors";
import { taskLogger as logger } from "../logger";
import {
  assertBoardOpen,
  assertCheckoutAuthorized,
  type BoardTaskRuntime,
  hasLiveTask,
  requireBoardTask,
  withBoardOperation,
} from "../runtime";
import { boardDirectory } from "../session-directory";

interface ManualReviewContext {
  answers: string[];
  board: WorkspaceBoard;
  boardId: string;
  directory: string;
  model: ModelSelection;
  questions: string[];
  sessionId: string;
  task: Task;
  taskId: string;
}

export class BoardTaskReview {
  readonly context: BoardTaskRuntime;

  constructor(context: BoardTaskRuntime) {
    this.context = context;
  }

  finalizeReview(
    boardId: string,
    taskId: string,
    rawInput: BoardTaskFinalizeReviewInput
  ): Promise<BoardTaskCommandResponse> {
    assertBoardOpen(this.context, boardId);
    const parsed = boardTaskFinalizeReviewInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new BoardTaskCommandError(
        "task_review_invalid",
        "The plan review data is invalid. Refresh the card and try again."
      );
    }
    return withBoardOperation(this.context, boardId, () =>
      this.#finalizeReviewInOperation(boardId, taskId, parsed.data)
    );
  }

  async #finalizeReviewInOperation(
    boardId: string,
    taskId: string,
    input: BoardTaskFinalizeReviewInput
  ): Promise<BoardTaskCommandResponse> {
    assertBoardOpen(this.context, boardId);
    const context = requireBoardTask(this.context, boardId, taskId);
    const existingResponse = this.#alreadyRunningReview(context);
    if (existingResponse) {
      return existingResponse;
    }

    const review = this.#manualReviewContext(
      context.board,
      context.task,
      input
    );
    await assertCheckoutAuthorized(this.context, review.directory);
    await this.context.bridge.subscribeDirectory(review.directory);

    const reserved = await this.#reserveReviewContinuation(review, input.plan);
    if (!reserved) {
      return this.#resolveReviewReservationConflict(boardId, taskId);
    }

    await this.#dispatchReviewContinuation(review, input.plan);
    this.context.watchdog?.start(review.sessionId, {
      boardId,
      directory: review.directory,
    });
    return {
      boardId,
      sessionId: review.sessionId,
      status: "accepted",
      taskId,
      timestamp: Date.now(),
    };
  }

  #alreadyRunningReview({
    board,
    task,
  }: {
    board: WorkspaceBoard;
    task: Task;
  }): BoardTaskCommandResponse | null {
    if (
      !(task.reviewApproved === true && board.session.currentTaskId === task.id)
    ) {
      return null;
    }
    const sessionId =
      task.run?.sessionId ?? task.runId ?? board.session.sessionId;
    if (!sessionId) {
      throw new BoardTaskCommandError(
        "task_session_missing",
        "This task's provider session is no longer attached to the board. Refresh and try again."
      );
    }
    return {
      boardId: board.boardId,
      sessionId,
      status: "already_running",
      taskId: task.id,
      timestamp: Date.now(),
    };
  }

  #manualReviewContext(
    board: WorkspaceBoard,
    task: Task,
    input: BoardTaskFinalizeReviewInput
  ): ManualReviewContext {
    if (
      !(board.columns.approve ?? []).some((entry) => entry.id === task.id) ||
      task.outcome !== "awaiting_review" ||
      task.reviewApproved === true
    ) {
      throw new BoardTaskCommandError(
        "task_not_reviewable",
        "This task is no longer waiting for plan review. Refresh the board."
      );
    }
    if (hasLiveTask(board, task.id)) {
      throw new BoardTaskCommandError(
        "board_busy",
        "Another task is already running on this board. Wait for it to finish before approving this plan."
      );
    }
    const model = task.promptInput?.model;
    if (!model) {
      throw new BoardTaskCommandError(
        "task_prompt_missing",
        "The task's original model is unavailable, so Chorus cannot safely continue it. Start a new task from this prompt."
      );
    }
    const sessionId = task.run?.sessionId ?? task.runId;
    if (
      !sessionId ||
      (board.session.sessionId && board.session.sessionId !== sessionId)
    ) {
      throw new BoardTaskCommandError(
        "task_session_missing",
        "This task's provider session is no longer attached to the board. Refresh and try again."
      );
    }

    const questions = task.questions ?? [];
    const answers = input.answers ?? task.questionAnswers ?? [];
    if (answers.length !== questions.length) {
      throw new BoardTaskCommandError(
        "task_review_invalid",
        "Answer each plan question before continuing."
      );
    }
    return {
      answers,
      board,
      boardId: board.boardId,
      directory: boardDirectory(board),
      model,
      questions,
      sessionId,
      task,
      taskId: task.id,
    };
  }

  #canReserveReview(currentBoard: WorkspaceBoard, review: ManualReviewContext) {
    const currentTask = findTaskInColumns(currentBoard.columns, review.taskId);
    return (
      currentTask?.outcome === "awaiting_review" &&
      currentTask.reviewApproved !== true &&
      (currentBoard.columns.approve ?? []).some(
        (entry) => entry.id === review.taskId
      ) &&
      !currentBoard.session.currentTaskId &&
      !hasLiveTask(currentBoard, review.taskId)
    );
  }

  #reserveReviewContinuation(
    review: ManualReviewContext,
    plan: string
  ): Promise<StoreCommit | null> {
    const timestamp = Date.now();
    return this.context.workspaceStore.applyBoardEventsIf(
      review.boardId,
      [
        {
          boardId: review.boardId,
          errorMessage: null,
          plan,
          questionAnswers: review.answers,
          reviewApproved: true,
          taskId: review.taskId,
          ts: timestamp,
          type: "board.task_plan_updated",
        },
        {
          boardId: review.boardId,
          session: {
            currentTaskId: review.taskId,
            errorMessage: undefined,
            state: "active",
          },
          ts: timestamp,
          type: "board.session_patched",
        },
      ],
      (currentBoard) => this.#canReserveReview(currentBoard, review)
    );
  }

  #resolveReviewReservationConflict(
    boardId: string,
    taskId: string
  ): BoardTaskCommandResponse {
    const latest = requireBoardTask(this.context, boardId, taskId);
    const existingResponse = this.#alreadyRunningReview(latest);
    if (existingResponse) {
      return existingResponse;
    }
    throw new BoardTaskCommandError(
      "task_not_reviewable",
      "This task changed while you were reviewing it. Refresh the card before trying again."
    );
  }

  #reviewContinuationText(review: ManualReviewContext, plan: string): string {
    const answerText = review.questions
      .map((question, index) => {
        const answer = review.answers[index] ?? "";
        return `- ${question}: ${answer || "(No answer provided.)"}`;
      })
      .join("\n");
    return [
      "The user reviewed and finalized the implementation plan below.",
      `Original task: ${review.task.promptInput?.text ?? review.task.title}`,
      `Final plan:\n${plan}`,
      answerText ? `Answers to plan questions:\n${answerText}` : "",
      "Proceed with implementing this plan in the current task session.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async #dispatchReviewContinuation(
    review: ManualReviewContext,
    plan: string
  ): Promise<void> {
    try {
      await this.context.bridge.promptSessionAsync({
        agent: "build",
        directory: review.directory,
        model: review.model,
        sessionID: review.sessionId,
        text: this.#reviewContinuationText(review, plan),
      });
    } catch (error) {
      await this.#recoverReviewDispatchFailure(review, plan);
      const message =
        "Chorus could not confirm that the provider accepted the implementation request. Check the task stream before retrying; your plan and answers are saved.";
      logger.error("finalize-review:dispatch-failed", {
        boardId: review.boardId,
        error: error instanceof Error ? error.message : String(error),
        sessionId: review.sessionId,
        taskId: review.taskId,
      });
      throw new BoardTaskCommandError("prompt_dispatch_failed", message);
    }
  }

  async #recoverReviewDispatchFailure(
    review: ManualReviewContext,
    plan: string
  ): Promise<void> {
    const timestamp = Date.now();
    try {
      await this.context.workspaceStore.applyBoardEventsIf(
        review.boardId,
        [
          {
            boardId: review.boardId,
            errorMessage:
              "Chorus could not confirm that the provider accepted the implementation request. Check the task stream before retrying; your plan and answers are saved.",
            plan,
            questionAnswers: review.answers,
            reviewApproved: false,
            taskId: review.taskId,
            ts: timestamp,
            type: "board.task_plan_updated",
          },
          {
            boardId: review.boardId,
            session: {
              currentTaskId: undefined,
              errorMessage: undefined,
              state: "active",
            },
            ts: timestamp,
            type: "board.session_patched",
          },
        ],
        (currentBoard) => currentBoard.session.currentTaskId === review.taskId
      );
    } catch (recoveryError) {
      logger.error("finalize-review:recovery-failed", {
        boardId: review.boardId,
        error:
          recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError),
        taskId: review.taskId,
      });
    }
  }

  rejectReview(
    boardId: string,
    taskId: string
  ): Promise<{
    accepted: true;
    boardId: string;
    taskId: string;
    timestamp: number;
  }> {
    assertBoardOpen(this.context, boardId);
    return withBoardOperation(this.context, boardId, async () => {
      assertBoardOpen(this.context, boardId);
      const board = this.context.workspaceStore.getBoard(boardId);
      const task = board ? findTaskInColumns(board.columns, taskId) : null;
      if (!(board && task)) {
        throw new BoardTaskCommandError(
          "task_not_found",
          "This task is no longer on the board. Refresh and try again."
        );
      }
      if (
        task.outcome !== "awaiting_review" ||
        task.reviewApproved === true ||
        board.session.currentTaskId === taskId ||
        !(board.columns.approve ?? []).some((entry) => entry.id === taskId)
      ) {
        throw new BoardTaskCommandError(
          "task_not_reviewable",
          "This task is no longer waiting for plan review. Refresh the board."
        );
      }
      if (hasLiveTask(board, taskId)) {
        throw new BoardTaskCommandError(
          "board_busy",
          "Another task is running on this board. Wait for it to finish before rejecting this plan."
        );
      }

      const commit = await this.context.workspaceStore.applyBoardEventsIf(
        boardId,
        [
          {
            boardId,
            reason: "Plan rejected by the user.",
            taskId,
            ts: Date.now(),
            type: "card.aborted",
          },
        ],
        (currentBoard) => {
          const currentTask = findTaskInColumns(currentBoard.columns, taskId);
          return (
            currentTask?.outcome === "awaiting_review" &&
            currentTask.reviewApproved !== true &&
            (currentBoard.columns.approve ?? []).some(
              (entry) => entry.id === taskId
            ) &&
            !hasLiveTask(currentBoard, taskId)
          );
        }
      );
      if (!commit) {
        throw new BoardTaskCommandError(
          "task_not_reviewable",
          "This task changed while you were reviewing it. Refresh the board."
        );
      }
      return { accepted: true, boardId, taskId, timestamp: Date.now() };
    });
  }
}
