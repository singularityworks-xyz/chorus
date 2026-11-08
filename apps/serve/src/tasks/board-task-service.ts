import { resolve } from "node:path";
import type {
  BoardTaskCommandResponse,
  BoardTaskFinalizeReviewInput,
  ModelSelection,
  QueueBoardPromptInput,
  QueueBoardPromptResponse,
  Task,
  WorkspaceBoard,
  WorkspaceMutation,
} from "@chorus/contracts";
import {
  boardTaskFinalizeReviewInputSchema,
  findTaskInColumns,
  queueBoardPromptInputSchema,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import { resolveInside, SandboxEscapeError } from "../paths/sandbox";
import type { RepositoryRegistry } from "../projects/repository-registry";
import type { StoreCommit, WorkspaceStore } from "../workspace/store";
import {
  type BoardSessionRecord,
  BoardSessionRegistry,
} from "./board-session-registry";
import { boardDirectory } from "./session-directory";
import type { SessionWatchdog } from "./session-watchdog";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "SERVE:TASKS"
);

export class SessionOwnershipError extends Error {
  readonly code: "session_ownership_conflict" | "session_directory_unknown";

  constructor(code: SessionOwnershipError["code"], message: string) {
    super(message);
    this.name = "SessionOwnershipError";
    this.code = code;
  }
}

export class BoardLifecycleError extends Error {
  readonly code: "board_closing" | "board_abort_failed";

  constructor(code: BoardLifecycleError["code"], message: string) {
    super(message);
    this.name = "BoardLifecycleError";
    this.code = code;
  }
}

export class GlobalModelNotConfiguredError extends Error {
  readonly code = "global_model_not_configured";

  constructor() {
    super("Choose one provider and model in Settings before starting a task.");
    this.name = "GlobalModelNotConfiguredError";
  }
}

export class BoardTaskCommandError extends Error {
  readonly code:
    | "board_busy"
    | "task_not_found"
    | "task_not_queued"
    | "task_not_retryable"
    | "task_not_abortable"
    | "abort_not_accepted"
    | "task_not_reviewable"
    | "task_session_missing"
    | "task_prompt_missing"
    | "task_review_invalid"
    | "prompt_dispatch_failed";

  constructor(code: BoardTaskCommandError["code"], message: string) {
    super(message);
    this.name = "BoardTaskCommandError";
    this.code = code;
  }
}

const BOARD_ABORT_TIMEOUT_MS = 5000;

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

type SdkPart =
  | { text: string; type: "text" }
  | { filename: string; mime: string; type: "file"; url: string };

/**
 * Resolves a prompt file-part against the board's directory (spec §6.4).
 *
 * The previous version joined relative paths and returned absolute ones
 * verbatim, so a client could name `/etc/shadow` or `../../../../root/.ssh/id_rsa`
 * and have the path handed to the engine as a `file://` URL — a read of any
 * file the serve process could reach, triggered by a queue-a-prompt request.
 *
 * `resolveInside` rejects traversal, absolute paths outside the root, NUL bytes,
 * and prefix-sibling roots (`/data2` against `/data`).
 */
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

/**
 * Exact path comparison, the way session scope is defined.
 *
 * Not a prefix test: `/repos/app` and `/repos/app-2` are different trees, and a
 * session opened in one must never be reused in the other. Trailing separators
 * and `.` segments are normalized so a client sending `/repos/app/` does not
 * fork needlessly.
 */
function sameDirectory(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!(left && right)) {
    return false;
  }
  return normalize(left) === normalize(right);
}

const TRAILING_SEPARATOR = /\/$/;

function normalize(path: string): string {
  return resolve(path).replace(TRAILING_SEPARATOR, "");
}

/**
 * Whether the board has active work or an unhandled manual plan review.
 *
 * A card in `done` is finished, so it is not a reason to skip creating a card for
 * new work.
 */
function hasLiveTask(board: WorkspaceBoard, excludeTaskId?: string): boolean {
  const currentTaskId = board.session.currentTaskId;
  if (currentTaskId && currentTaskId !== excludeTaskId) {
    const currentTask = findTaskInColumns(board.columns, currentTaskId);
    if (
      currentTask &&
      !(board.columns.done ?? []).some((task) => task.id === currentTaskId)
    ) {
      return true;
    }
  }

  return (board.columns.approve ?? []).some(
    (task) =>
      task.id !== excludeTaskId &&
      task.outcome === "awaiting_review" &&
      task.reviewApproved !== true
  );
}

export class BoardTaskService {
  readonly #bridge: OpenCodeBridge;
  readonly #registry: BoardSessionRegistry;
  readonly #workspaceStore: WorkspaceStore;
  readonly #watchdog: SessionWatchdog | null;
  readonly #boardOperations = new Map<string, Promise<void>>();
  readonly #removals = new Map<string, Promise<StoreCommit | null>>();
  readonly #closingBoards = new Set<string>();
  readonly #repositoryRegistry: RepositoryRegistry | undefined;

  constructor(
    bridge: OpenCodeBridge,
    workspaceStore: WorkspaceStore,
    registry = new BoardSessionRegistry(),
    watchdog: SessionWatchdog | null = null,
    repositoryRegistry?: RepositoryRegistry
  ) {
    this.#bridge = bridge;
    this.#workspaceStore = workspaceStore;
    this.#registry = registry;
    this.#watchdog = watchdog;
    this.#repositoryRegistry = repositoryRegistry;
  }

  get registry() {
    return this.#registry;
  }

  getWorkspaceSnapshot() {
    return this.#workspaceStore.getSnapshot();
  }

  assertBoardOpen(boardId: string): void {
    if (this.#closingBoards.has(boardId)) {
      throw new BoardLifecycleError(
        "board_closing",
        "this board is closing and cannot accept commands"
      );
    }
  }

  async assertCheckoutAuthorized(directory: string): Promise<void> {
    await this.#repositoryRegistry?.validateAuthorizedCheckout(directory);
  }

  async removeBoard(
    mutation: Extract<WorkspaceMutation, { type: "board.remove" }>
  ): Promise<StoreCommit | null> {
    const boardId = mutation.payload.boardId;
    const existing = this.#removals.get(boardId);
    if (existing) {
      return existing;
    }
    this.assertBoardOpen(boardId);
    this.#closingBoards.add(boardId);
    const removal = this.#withBoardOperation(boardId, async () => {
      const board = this.#workspaceStore.getBoard(boardId);
      if (!board) {
        return this.#workspaceStore.applyMutation(mutation);
      }
      const sessionId = board.session.sessionId;
      if (sessionId && board.session.state === "active") {
        const directory = boardDirectory(board);
        const stoppedByAbort = await this.#abortSessionAndConfirmIdle(
          sessionId,
          directory
        );
        if (stoppedByAbort) {
          this.#watchdog?.stop(sessionId);
          await this.#workspaceStore.updateBoardSession(boardId, {
            errorMessage:
              "The agent was stopped for board removal; this checkout was retained if removal could not finish.",
            state: "error",
          });
        }
      }
      return this.#workspaceStore.applyMutation(mutation);
    });
    this.#removals.set(boardId, removal);
    try {
      return await removal;
    } finally {
      if (this.#removals.get(boardId) === removal) {
        this.#removals.delete(boardId);
        this.#closingBoards.delete(boardId);
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
      if (await this.#bridge.waitForSessionIdle(sessionId, directory, 0)) {
        return false;
      }

      const aborted = await Promise.race([
        this.#bridge.abortSession(sessionId, directory),
        timeout,
      ]);
      if (!aborted) {
        if (await this.#bridge.waitForSessionIdle(sessionId, directory, 0)) {
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
        this.#bridge.waitForSessionIdle(
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

  async #withBoardOperation<T>(
    boardId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.#boardOperations.get(boardId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.#boardOperations.set(boardId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#boardOperations.get(boardId) === current) {
        this.#boardOperations.delete(boardId);
      }
    }
  }

  /**
   * Makes sure the board has a card for this prompt, and that it is the board's
   * current task.
   *
   * This is the step that was missing, and nothing else could stand in for it.
   * A queued prompt is an explicit human command, so spec§2 rule 3 puts the
   * transition on the server. `board.session.currentTaskId` is what
   * `WorkspaceStore.applyAgentEvent` uses as the task id for every agent event
   * it converts, and it drops any task-scoped event whose id is empty — so with
   * no card, a running agent produced activity that was filtered away and
   * discarded without a log line. `card.created` is also the only projector
   * branch that sets `currentTaskId`.
   *
   * A fresh prompt or retry creates one card. Run targets the existing queued
   * card and passes its taskId so the server does not create a duplicate.
   */
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
    const commit = await this.#workspaceStore.applyBoardEventsIf(
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
    const currentTaskId = this.#workspaceStore.getBoard(input.boardId)?.session
      .currentTaskId;
    if (!currentTaskId) {
      throw new BoardTaskCommandError(
        "board_busy",
        "This board already has work in progress. Wait for it to finish before starting another task."
      );
    }
    return currentTaskId;
  }

  /**
   * Picks the session a prompt runs in, or forks a new one.
   *
   * A session belongs to the directory it was opened in (plan P6 task 3). None of
   * the three candidate sources compared directories, so any of them could hand
   * back a session scoped to a different tree and the agent would silently work
   * in the wrong checkout — which worktree-per-board makes routine, since one
   * repo now has a primary path plus N worktree paths. The registry already stored
   * `directory` and nothing read it.
   *
   * On a mismatch the session is forked rather than discarded, so the transcript
   * so far survives: a hard redirect is a continuation, not a restart.
   */
  /**
   * The directory a candidate session was opened in, or null when unknown.
   *
   * The in-memory registry records the directory at the moment a session was
   * bound, so it is authoritative and free. After a restart it is empty and the
   * store holds a session id with no path attached, so the engine is asked
   * instead — it is the only thing that actually knows. A board's worktree is fixed
   * at creation, so the common case simply matches; the engine check is what
   * catches a session id that belonged to a different board's checkout.
   *
   * A failed lookup yields null, which reads as "unknown" and therefore reuses.
   * Forking on a transient engine error would strand a session that was fine.
   */
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
      const session = await this.#bridge.getSession({
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

      const forked = await this.#bridge.forkSession({
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

    const session = await this.#bridge.createSession({
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
    this.assertBoardOpen(parsed.boardId);
    return this.#withBoardOperation(parsed.boardId, () => {
      this.assertBoardOpen(parsed.boardId);
      const board = this.#workspaceStore.getBoard(parsed.boardId);
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
    this.assertBoardOpen(boardId);
    return this.#withBoardOperation(boardId, async () => {
      this.assertBoardOpen(boardId);
      const board = this.#workspaceStore.getBoard(boardId);
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
    this.assertBoardOpen(boardId);
    return this.#withBoardOperation(boardId, async () => {
      this.assertBoardOpen(boardId);
      const board = this.#workspaceStore.getBoard(boardId);
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
        sessionId: response.sessionId,
        status: "accepted",
        taskId: response.taskId,
        timestamp: response.timestamp,
      };
    });
  }

  abortTask(
    boardId: string,
    taskId: string
  ): Promise<BoardTaskCommandResponse> {
    this.assertBoardOpen(boardId);
    return this.#withBoardOperation(boardId, async () => {
      this.assertBoardOpen(boardId);
      const { board, task } = this.#requireBoardTask(boardId, taskId);
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
      await this.assertCheckoutAuthorized(directory);
      await this.#bridge.subscribeDirectory(directory);
      const stoppedByAbort = await this.#abortSessionAndConfirmIdle(
        sessionId,
        directory,
        "stop"
      );
      const timestamp = Date.now();

      if (stoppedByAbort) {
        await this.#workspaceStore.applyBoardEventsIf(
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
        await this.#workspaceStore.applyBoardEventsIf(
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

      this.#watchdog?.stop(sessionId);
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

  finalizeReview(
    boardId: string,
    taskId: string,
    rawInput: BoardTaskFinalizeReviewInput
  ): Promise<BoardTaskCommandResponse> {
    this.assertBoardOpen(boardId);
    const parsed = boardTaskFinalizeReviewInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new BoardTaskCommandError(
        "task_review_invalid",
        "The plan review data is invalid. Refresh the card and try again."
      );
    }
    return this.#withBoardOperation(boardId, () =>
      this.#finalizeReviewInOperation(boardId, taskId, parsed.data)
    );
  }

  async #finalizeReviewInOperation(
    boardId: string,
    taskId: string,
    input: BoardTaskFinalizeReviewInput
  ): Promise<BoardTaskCommandResponse> {
    this.assertBoardOpen(boardId);
    const context = this.#requireBoardTask(boardId, taskId);
    const existingResponse = this.#alreadyRunningReview(context);
    if (existingResponse) {
      return existingResponse;
    }

    const review = this.#manualReviewContext(
      context.board,
      context.task,
      input
    );
    await this.assertCheckoutAuthorized(review.directory);
    await this.#bridge.subscribeDirectory(review.directory);

    const reserved = await this.#reserveReviewContinuation(review, input.plan);
    if (!reserved) {
      return this.#resolveReviewReservationConflict(boardId, taskId);
    }

    await this.#dispatchReviewContinuation(review, input.plan);
    this.#watchdog?.start(review.sessionId, {
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

  #requireBoardTask(boardId: string, taskId: string) {
    const board = this.#workspaceStore.getBoard(boardId);
    const task = board ? findTaskInColumns(board.columns, taskId) : null;
    if (!(board && task)) {
      throw new BoardTaskCommandError(
        "task_not_found",
        "This task is no longer on the board. Refresh and try again."
      );
    }
    return { board, task };
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
    return this.#workspaceStore.applyBoardEventsIf(
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
    const latest = this.#requireBoardTask(boardId, taskId);
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
      await this.#bridge.promptSessionAsync({
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
      await this.#workspaceStore.applyBoardEventsIf(
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
    this.assertBoardOpen(boardId);
    return this.#withBoardOperation(boardId, async () => {
      this.assertBoardOpen(boardId);
      const board = this.#workspaceStore.getBoard(boardId);
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

      const commit = await this.#workspaceStore.applyBoardEventsIf(
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
    const existing = this.#registry.get(parsed.boardId);
    const persistedBoard = this.#workspaceStore.getBoard(parsed.boardId);

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
    await this.assertCheckoutAuthorized(directory);

    const defaultModelSelection =
      this.#workspaceStore.getSnapshot().preferences.defaultModelSelection;
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

    await this.#bridge.subscribeDirectory(input.directory);

    const { createdSession, sessionId } = await this.#resolveSession({
      existing,
      input,
      persistedBoard,
    });

    this.#registry.set({
      boardId: input.boardId,
      sessionId,
      directory: input.directory,
      projectId: input.projectId,
    });

    await this.#workspaceStore.updateBoardSession(input.boardId, {
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

        await this.#workspaceStore.updateBoardReviewMode(
          input.boardId,
          "manual"
        );

        await this.#bridge.promptSessionAsync({
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

        await this.#bridge.promptSessionAsync({
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
      await this.#workspaceStore.applyBoardEvents(input.boardId, [
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

    this.#watchdog?.start(sessionId, {
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
