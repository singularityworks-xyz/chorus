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
import { resolveInside, SandboxEscapeError } from "../../paths/sandbox";
import type { BoardSessionRecord } from "../board-session-registry";
import {
  BoardTaskCommandError,
  GlobalModelNotConfiguredError,
  SessionOwnershipError,
} from "../errors";
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

type SdkPart =
  | { text: string; type: "text" }
  | { filename: string; mime: string; type: "file"; url: string };

function resolveFilePath(rawPath: string, directory: string): string {
  try {
    return resolveInside(directory, rawPath);
  } catch (error) {
    if (error instanceof SandboxEscapeError || error instanceof Error) {
      logger.warn("file-part-rejected", { reason: error.name });
    }
    throw error;
  }
}

function convertPartsToSdk(
  parts: NonNullable<QueueBoardPromptInput["parts"]>,
  directory: string
): SdkPart[] {
  return parts.flatMap(
    (part: {
      type: string;
      text?: string;
      filename?: string;
      path?: string;
      mime?: string;
      isDirectory?: boolean;
      lineRange?: { start: number; end: number };
    }) => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text ?? "" };
      }
      if (part.type === "file") {
        const resolvedPath = resolveFilePath(part.path ?? "", directory);
        const fileUrl = `file://${resolvedPath}`;
        const rangeParams = part.lineRange
          ? `?start=${part.lineRange.start}&end=${part.lineRange.end}`
          : "";
        logger.debug("file-part-resolved", {
          rawPath: part.path,
          resolvedPath,
          fileUrl,
          filename: part.filename,
          mime: part.mime,
          isDirectory: part.isDirectory,
        });
        return {
          type: "file" as const,
          filename: part.filename ?? "",
          mime: part.isDirectory
            ? "application/x-directory"
            : (part.mime ?? "text/plain"),
          url: fileUrl + rangeParams,
        };
      }
      return [];
    }
  );
}

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

    // The "does this board already have a live task" decision is made inside the
    // store's queue, not here. Reading it here and committing after would let two
    // concurrent prompts for one board both see no current task and both create a
    // card, which breaks the idempotence this method promises.
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

    // A lost duplicate card creation is safe to resolve only to the task that
    // already owns the board's live session. Public queueing rejects a busy
    // board; this fallback is for a concurrent event that won the store queue.
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

  async #candidateDirectory({
    candidate,
    existing,
    input,
  }: {
    candidate: string | undefined;
    existing: BoardSessionRecord | undefined;
    input: QueueBoardPromptInput;
  }): Promise<string | null> {
    if (!candidate) {
      return null;
    }

    // Only when the candidate *is* the registry's session.
    //
    // The registry records where this board's own session was opened, which says
    // nothing about a session id the client supplied. Taking the shortcut for a
    // client-supplied id would validate the board's directory instead of the
    // candidate's, and then reuse and persist someone else's session.
    if (existing?.directory && candidate === existing.sessionId) {
      return existing.directory;
    }

    try {
      // Queried *without* the target directory. Passing it would scope the lookup
      // to the very checkout we are trying to validate, so an unrelated session
      // cannot appear valid just because the request supplied the target path.
      const session = await this.context.bridge.getSession({
        sessionID: candidate,
        engineDirectory: input.directory,
      });
      return session.directory ?? null;
    } catch {
      logger.warn("queue-prompt:session-directory-unknown", {
        boardId: input.boardId,
        sessionId: candidate,
      });
      return null;
    }
  }

  async #resolveSession({
    existing,
    input,
    persistedBoard,
  }: {
    existing: BoardSessionRecord | undefined;
    input: QueueBoardPromptInput;
    persistedBoard: WorkspaceBoard | undefined;
  }): Promise<{ createdSession: boolean; sessionId: string }> {
    const boundSessionId =
      existing?.sessionId ?? persistedBoard?.session.sessionId;
    if (input.sessionId && input.sessionId !== boundSessionId) {
      throw new SessionOwnershipError(
        "session_ownership_conflict",
        "the supplied session is not bound to this board"
      );
    }

    const candidate = boundSessionId;
    const candidateDirectory = candidate
      ? await this.#candidateDirectory({ candidate, existing, input })
      : null;

    if (candidate && candidateDirectory === null) {
      throw new SessionOwnershipError(
        "session_directory_unknown",
        "the engine could not verify this board's session directory; retry when the engine is available"
      );
    }

    // A known mismatch is only forked after the current board binding is proven.
    if (
      candidate &&
      candidateDirectory !== null &&
      !sameDirectory(candidateDirectory, input.directory)
    ) {
      logger.info("queue-prompt:session-directory-mismatch", {
        boardId: input.boardId,
        candidateDirectory,
        directory: input.directory,
        sessionId: candidate,
      });

      const forked = await this.context.bridge.forkSession({
        directory: input.directory,
        sessionID: candidate,
      });
      logger.info("queue-prompt:session-forked", {
        boardId: input.boardId,
        directory: input.directory,
        from: candidate,
        sessionId: forked.id,
      });
      return { createdSession: true, sessionId: forked.id };
    }

    if (candidate) {
      let source = "persisted";
      if (input.sessionId) {
        source = "input";
      } else if (existing) {
        source = "registry";
      }

      logger.info("queue-prompt:reusing-session", {
        boardId: input.boardId,
        sessionId: candidate,
        source,
      });
      return { createdSession: false, sessionId: candidate };
    }

    logger.info("queue-prompt:creating-session", {
      boardId: input.boardId,
      directory: input.directory,
    });

    const session = await this.context.bridge.createSession({
      title: input.text.slice(0, 80),
      directory: input.directory,
    });

    logger.info("queue-prompt:session-created", {
      boardId: input.boardId,
      sessionId: session.id,
    });

    return { createdSession: true, sessionId: session.id };
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
      // Refused rather than falling back to the caller's directory. A prompt for a
      // board the store does not know is either a stale client or an attempt to
      // skip board creation and aim the engine at an arbitrary path; the fallback
      // made the second one work.
      throw new Error(
        `no such board: ${parsed.boardId}. A prompt can only run against a board the server knows.`
      );
    }

    // The working directory is the board's, not the caller's (plan P6 task 3).
    //
    // `repo.worktree` is the whole point of worktree-per-board: the first board
    // for a repo keeps the primary checkout, and every additional board gets its
    // own. Resolving it here rather than trusting `input.directory` means the
    // agent actually runs in its own worktree, and a client cannot aim a prompt
    // at an arbitrary path on the host.
    // One resolver with the follow-up command paths, so a board's checkout is
    // computed the same way everywhere (session-directory.ts).
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
      // The synced workspace preference is authoritative. Never let a stale
      // board model or browser request select a different provider.
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

    const { createdSession, sessionId } = await this.#resolveSession({
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
