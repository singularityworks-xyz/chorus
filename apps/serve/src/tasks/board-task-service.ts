import type {
  QueueBoardPromptInput,
  QueueBoardPromptResponse,
} from "@chorus/contracts";
import { queueBoardPromptInputSchema } from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import { resolveInside, SandboxEscapeError } from "../paths/sandbox";
import type { WorkspaceStore } from "../workspace/store";
import { BoardSessionRegistry } from "./board-session-registry";
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

  async queuePrompt(
    rawInput: QueueBoardPromptInput
  ): Promise<QueueBoardPromptResponse> {
    const input = queueBoardPromptInputSchema.parse(rawInput);
    const existing = this.#registry.get(input.boardId);
    const persistedBoard = this.#workspaceStore.getBoard(input.boardId);

    logger.info("queue-prompt:start", {
      boardId: input.boardId,
      directory: input.directory,
      model: input.model
        ? `${input.model.providerID}/${input.model.modelID}`
        : undefined,
      reviewMode: input.reviewMode,
      textPreview: input.text.slice(0, 100),
    });

    await this.#bridge.subscribeDirectory(input.directory);

    let sessionId =
      input.sessionId ??
      existing?.sessionId ??
      persistedBoard?.session.sessionId;
    let createdSession = false;

    if (sessionId) {
      let source = "persisted";
      if (input.sessionId) {
        source = "input";
      } else if (existing) {
        source = "registry";
      }

      logger.info("queue-prompt:reusing-session", {
        sessionId,
        boardId: input.boardId,
        source,
      });
    } else {
      logger.info("queue-prompt:creating-session", {
        boardId: input.boardId,
        directory: input.directory,
      });

      const session = await this.#bridge.createSession({
        title: input.text.slice(0, 80),
        directory: input.directory,
      });

      sessionId = session.id;
      createdSession = true;

      logger.info("queue-prompt:session-created", {
        sessionId,
        boardId: input.boardId,
      });
    }

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
