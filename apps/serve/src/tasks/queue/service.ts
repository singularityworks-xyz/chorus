import type {
  BoardTaskCommandResponse,
  QueueBoardPromptInput,
  QueueBoardPromptResponse,
  WorkspaceBoard,
} from "@chorus/contracts";
import {
  findTaskInColumns,
  queueBoardPromptInputSchema,
} from "@chorus/contracts";
import {
  BoardTaskCommandError,
  GlobalModelNotConfiguredError,
} from "../errors";
import { taskLogger as logger } from "../logger";
import {
  assertBoardOpen,
  assertCheckoutAuthorized,
  type BoardTaskRuntime,
  hasLiveTask,
  withBoardOperation,
} from "../runtime";
import { boardDirectory } from "../session-directory";
import { convertPartsToSdk } from "./prompt-parts";
import { resolveBoardSession } from "./session-resolution";

export class BoardTaskQueue {
  readonly context: BoardTaskRuntime;

  constructor(context: BoardTaskRuntime) {
    this.context = context;
  }

  async #ensureQueuedCard(
    input: QueueBoardPromptInput,
    sessionId: string,
    options: { retryOf?: string; taskId?: string } = {}
  ): Promise<string> {
    const taskId = options.taskId ?? `task-${crypto.randomUUID()}`;
    if (options.taskId) {
      return taskId;
    }
    const title = input.text.slice(0, 120);

    // Create the card and check the live-task invariant in one store transaction.
    const commit = await this.context.workspaceStore.applyBoardEventsIf(
      input.boardId,
      [
        {
          boardId: input.boardId,
          column: "queue",
          task: {
            id: taskId,
            label: title,
            labelVariant: "primary-light",
            promptInput: {
              agent: input.agent,
              model: input.model,
              parts: input.parts,
              reviewMode: input.reviewMode,
              text: input.text,
            },
            ...(options.retryOf ? { retryOf: options.retryOf } : {}),
            title,
          },
          taskId,
          ts: Date.now(),
          type: "card.created",
        },
      ],
      (board) => !hasLiveTask(board)
    );

    logger.info("queue-prompt:card-created", {
      boardId: input.boardId,
      committed: commit !== null,
      sessionId,
      taskId,
    });

    if (commit) {
      return taskId;
    }

    // A racing request can only reuse the task that won the store transaction.
    const currentTaskId = this.context.workspaceStore.getBoard(input.boardId)
      ?.session.currentTaskId;
    if (!currentTaskId) {
      throw new BoardTaskCommandError(
        "board_busy",
        "This board already has work in progress. Wait for it to finish before starting another task."
      );
    }
    return currentTaskId;
  }

  queuePrompt(
    rawInput: QueueBoardPromptInput
  ): Promise<QueueBoardPromptResponse> {
    const parsed = queueBoardPromptInputSchema.parse(rawInput);
    assertBoardOpen(this.context, parsed.boardId);
    return withBoardOperation(this.context, parsed.boardId, () => {
      assertBoardOpen(this.context, parsed.boardId);
      const board = this.context.workspaceStore.getBoard(parsed.boardId);
      if (!board) {
        throw new Error(`no such board: ${parsed.boardId}`);
      }
      if (hasLiveTask(board)) {
        throw new BoardTaskCommandError(
          "board_busy",
          "This board already has work in progress. Wait for it to finish before starting another task."
        );
      }
      return this.#queuePromptParsed(parsed);
    });
  }

  runQueuedTask(
    boardId: string,
    taskId: string
  ): Promise<BoardTaskCommandResponse> {
    assertBoardOpen(this.context, boardId);
    return withBoardOperation(this.context, boardId, async () => {
      assertBoardOpen(this.context, boardId);
      const board = this.context.workspaceStore.getBoard(boardId);
      if (!board) {
        throw new BoardTaskCommandError(
          "task_not_found",
          "This task is no longer on the board. Refresh and try again."
        );
      }
      const task = findTaskInColumns(board.columns, taskId);
      if (!task) {
        throw new BoardTaskCommandError(
          "task_not_found",
          "This task is no longer on the board. Refresh and try again."
        );
      }
      if (!(board.columns.queue ?? []).some((entry) => entry.id === taskId)) {
        throw new BoardTaskCommandError(
          "task_not_queued",
          "Only a queued task can be started."
        );
      }
      if (!task.promptInput) {
        throw new BoardTaskCommandError(
          "task_prompt_missing",
          "This older task does not contain its original prompt and cannot be run again."
        );
      }
      if (
        board.session.currentTaskId === taskId &&
        board.session.state === "active"
      ) {
        const sessionId = board.session.sessionId;
        if (sessionId) {
          return {
            boardId,
            sessionId,
            status: "already_running",
            taskId,
            timestamp: Date.now(),
          };
        }
      }
      if (hasLiveTask(board) && board.session.currentTaskId !== taskId) {
        throw new BoardTaskCommandError(
          "board_busy",
          "Another task is already running on this board. Wait for it to finish before starting this one."
        );
      }

      const response = await this.#queuePromptParsed(
        this.#inputFromTask(board, task.promptInput),
        { taskId }
      );
      return {
        boardId,
        sessionId: response.sessionId,
        status: "accepted",
        taskId,
        timestamp: response.timestamp,
      };
    });
  }

  retryTask(
    boardId: string,
    taskId: string
  ): Promise<BoardTaskCommandResponse> {
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
      if (!(board.columns.done ?? []).some((entry) => entry.id === taskId)) {
        throw new BoardTaskCommandError(
          "task_not_retryable",
          "Only a finished task can be retried."
        );
      }
      if (!task.promptInput) {
        throw new BoardTaskCommandError(
          "task_prompt_missing",
          "This older task does not contain its original prompt and cannot be retried."
        );
      }
      if (hasLiveTask(board)) {
        throw new BoardTaskCommandError(
          "board_busy",
          "Another task is already running on this board. Wait for it to finish before retrying."
        );
      }

      const response = await this.#queuePromptParsed(
        this.#inputFromTask(board, task.promptInput),
        { retryOf: taskId }
      );
      return {
        boardId,
        retryOf: taskId,
        sessionId: response.sessionId,
        status: "accepted",
        taskId: response.taskId,
        timestamp: response.timestamp,
      };
    });
  }

  #inputFromTask(
    board: WorkspaceBoard,
    promptInput: NonNullable<
      WorkspaceBoard["columns"][string][number]["promptInput"]
    >
  ): QueueBoardPromptInput {
    return {
      agent: promptInput.agent,
      boardId: board.boardId,
      directory: boardDirectory(board),
      model: promptInput.model,
      parts: promptInput.parts,
      projectId: board.repo.projectId,
      reviewMode: promptInput.reviewMode,
      sessionId: board.session.sessionId,
      text: promptInput.text,
    };
  }

  async #queuePromptParsed(
    parsed: QueueBoardPromptInput,
    options: { retryOf?: string; taskId?: string } = {}
  ): Promise<QueueBoardPromptResponse> {
    const existing = this.context.registry.get(parsed.boardId);
    const persistedBoard = this.context.workspaceStore.getBoard(parsed.boardId);

    if (!persistedBoard) {
      // A queued prompt must reference a persisted board; never trust a caller path alone.
      throw new Error(
        `no such board: ${parsed.boardId}. A prompt can only run against a board the server knows.`
      );
    }

    // The board's checkout is authoritative; the request path is advisory.
    const directory = boardDirectory(persistedBoard);
    await assertCheckoutAuthorized(this.context, directory);

    const defaultModelSelection =
      this.context.workspaceStore.getSnapshot().preferences
        .defaultModelSelection;
    if (!defaultModelSelection) {
      throw new GlobalModelNotConfiguredError();
    }

    const input: QueueBoardPromptInput = {
      ...parsed,
      directory,
      // Use the synced model selection instead of stale client values.
      model: defaultModelSelection,
    };

    logger.info("queue-prompt:start", {
      boardId: input.boardId,
      directory: input.directory,
      requestedDirectory: parsed.directory,
      model: input.model
        ? `${input.model.providerID}/${input.model.modelID}`
        : undefined,
      reviewMode: input.reviewMode,
    });

    await this.context.bridge.subscribeDirectory(input.directory);

    const { createdSession, sessionId } = await resolveBoardSession({
      context: this.context,
      existing,
      input,
      persistedBoard,
    });

    this.context.registry.set({
      boardId: input.boardId,
      sessionId,
      directory: input.directory,
      projectId: input.projectId,
    });

    await this.context.workspaceStore.updateBoardSession(input.boardId, {
      errorMessage: undefined,
      sessionId,
      state: "active",
    });

    const taskId = await this.#ensureQueuedCard(input, sessionId, options);

    const sdkParts = input.parts
      ? convertPartsToSdk(input.parts, input.directory)
      : [];

    try {
      if (input.reviewMode === "manual") {
        logger.info("queue-prompt:manual-review-mode", {
          sessionId,
          boardId: input.boardId,
        });

        await this.context.workspaceStore.updateBoardReviewMode(
          input.boardId,
          "manual"
        );

        await this.context.bridge.promptSessionAsync({
          sessionID: sessionId,
          directory: input.directory,
          text: input.text,
          model: input.model,
          agent: "plan",
          parts: sdkParts.length > 0 ? sdkParts : undefined,
        });
      } else {
        logger.info("queue-prompt:sending-async", {
          sessionId,
          boardId: input.boardId,
          directory: input.directory,
          model: input.model
            ? `${input.model.providerID}/${input.model.modelID}`
            : undefined,
        });

        await this.context.bridge.promptSessionAsync({
          sessionID: sessionId,
          directory: input.directory,
          text: input.text,
          model: input.model,
          agent: input.agent,
          parts: sdkParts.length > 0 ? sdkParts : undefined,
        });
      }
    } catch (error) {
      const message =
        "Chorus could not confirm that the provider accepted this task. Your prompt is saved on the board; check the provider session before retrying.";
      logger.error("queue-prompt:dispatch-failed", {
        boardId: input.boardId,
        error: error instanceof Error ? error.message : String(error),
        sessionId,
        taskId,
      });
      await this.context.workspaceStore.applyBoardEvents(input.boardId, [
        {
          boardId: input.boardId,
          error: message,
          taskId,
          ts: Date.now(),
          type: "card.failed",
        },
      ]);
      throw new BoardTaskCommandError("prompt_dispatch_failed", message);
    }

    this.context.watchdog?.start(sessionId, {
      boardId: input.boardId,
      directory: input.directory,
    });

    logger.info("queue-prompt:prompt-queued", {
      sessionId,
      boardId: input.boardId,
    });

    return {
      boardId: input.boardId,
      sessionId,
      taskId,
      createdSession,
      accepted: true,
      timestamp: Date.now(),
    };
  }
}
