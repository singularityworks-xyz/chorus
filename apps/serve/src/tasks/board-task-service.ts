import { resolve } from "node:path";
import type {
  QueueBoardPromptInput,
  QueueBoardPromptResponse,
  WorkspaceBoard,
} from "@chorus/contracts";
import { queueBoardPromptInputSchema } from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import { resolveInside, SandboxEscapeError } from "../paths/sandbox";
import type { WorkspaceStore } from "../workspace/store";
import {
  type BoardSessionRecord,
  BoardSessionRegistry,
} from "./board-session-registry";
import type { SessionWatchdog } from "./session-watchdog";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "SERVE:TASKS"
);

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

export class BoardTaskService {
  readonly #bridge: OpenCodeBridge;
  readonly #registry: BoardSessionRegistry;
  readonly #workspaceStore: WorkspaceStore;
  readonly #watchdog: SessionWatchdog | null;

  constructor(
    bridge: OpenCodeBridge,
    workspaceStore: WorkspaceStore,
    registry = new BoardSessionRegistry(),
    watchdog: SessionWatchdog | null = null
  ) {
    this.#bridge = bridge;
    this.#workspaceStore = workspaceStore;
    this.#registry = registry;
    this.#watchdog = watchdog;
  }

  get registry() {
    return this.#registry;
  }

  getWorkspaceSnapshot() {
    return this.#workspaceStore.getSnapshot();
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
   * Idempotent: a board that already has a live current task reuses it rather
   * than stacking a second card for the same run.
   */
  async #ensureQueuedCard(
    input: QueueBoardPromptInput,
    sessionId: string
  ): Promise<void> {
    const board = this.#workspaceStore.getBoard(input.boardId);
    if (!board) {
      return;
    }

    if (board.session.currentTaskId) {
      return;
    }

    const taskId = `task-${crypto.randomUUID()}`;
    const title = input.text.slice(0, 120);

    const commit = await this.#workspaceStore.applyBoardEvents(input.boardId, [
      {
        boardId: input.boardId,
        column: "queue",
        task: {
          id: taskId,
          label: title,
          labelVariant: "primary-light",
          title,
        },
        taskId,
        ts: Date.now(),
        type: "card.created",
      },
    ]);

    logger.info("queue-prompt:card-created", {
      boardId: input.boardId,
      committed: commit !== null,
      sessionId,
      taskId,
    });
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
   * The directory a board's agent runs in.
   *
   * Prefers the board's own worktree, falling back to the repo's primary
   * checkout for a board that has one, and finally to the requested path when the
   * board is unknown to the store.
   */
  #workingDirectoryFor(
    board: WorkspaceBoard | undefined,
    input: QueueBoardPromptInput
  ): string {
    return board?.repo.worktree ?? board?.repo.directory ?? input.directory;
  }

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

    if (existing?.directory) {
      return existing.directory;
    }

    try {
      const session = await this.#bridge.getSession({
        directory: input.directory,
        sessionID: candidate,
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
    const candidate =
      input.sessionId ??
      existing?.sessionId ??
      persistedBoard?.session.sessionId;

    const candidateDirectory = await this.#candidateDirectory({
      candidate,
      existing,
      input,
    });

    // Only a *known* mismatch forks. `candidateDirectory === null` means the
    // directory could not be established at all, and treating that as "different"
    // would fork a session that was in the right place every time the engine was
    // briefly unreachable.
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

  async queuePrompt(
    rawInput: QueueBoardPromptInput
  ): Promise<QueueBoardPromptResponse> {
    const parsed = queueBoardPromptInputSchema.parse(rawInput);
    const existing = this.#registry.get(parsed.boardId);
    const persistedBoard = this.#workspaceStore.getBoard(parsed.boardId);

    // The working directory is the board's, not the caller's (plan P6 task 3).
    //
    // `repo.worktree` is the whole point of worktree-per-board: the first board
    // for a repo keeps the primary checkout, and every additional board gets its
    // own. Resolving it here rather than trusting `input.directory` means the
    // agent actually runs in its own worktree, and a client cannot aim a prompt
    // at an arbitrary path on the host.
    const directory = this.#workingDirectoryFor(persistedBoard, parsed);

    const input: QueueBoardPromptInput = { ...parsed, directory };

    logger.info("queue-prompt:start", {
      boardId: input.boardId,
      directory: input.directory,
      requestedDirectory: parsed.directory,
      model: input.model
        ? `${input.model.providerID}/${input.model.modelID}`
        : undefined,
      reviewMode: input.reviewMode,
      textPreview: input.text.slice(0, 100),
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

    await this.#ensureQueuedCard(input, sessionId);

    const sdkParts = input.parts
      ? convertPartsToSdk(input.parts, input.directory)
      : [];

    if (input.reviewMode === "manual") {
      logger.info("queue-prompt:manual-review-mode", {
        sessionId,
        boardId: input.boardId,
      });

      await this.#workspaceStore.updateBoardReviewMode(input.boardId, "manual");

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
      createdSession,
      accepted: true,
      timestamp: Date.now(),
    };
  }
}
