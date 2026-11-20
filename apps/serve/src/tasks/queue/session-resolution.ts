import type { QueueBoardPromptInput, WorkspaceBoard } from "@chorus/contracts";
import type { BoardSessionRecord } from "../board-session-registry";
import { SessionOwnershipError } from "../errors";
import { taskLogger as logger } from "../logger";
import { type BoardTaskRuntime, sameDirectory } from "../runtime";

interface ResolveBoardSessionInput {
  context: BoardTaskRuntime;
  existing: BoardSessionRecord | undefined;
  input: QueueBoardPromptInput;
  persistedBoard: WorkspaceBoard | undefined;
}

async function candidateDirectory(
  context: BoardTaskRuntime,
  candidate: string | undefined,
  existing: BoardSessionRecord | undefined,
  input: QueueBoardPromptInput
): Promise<string | null> {
  if (!candidate) {
    return null;
  }
  if (existing?.directory && candidate === existing.sessionId) {
    return existing.directory;
  }

  try {
    const session = await context.bridge.getSession({
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

export async function resolveBoardSession({
  context,
  existing,
  input,
  persistedBoard,
}: ResolveBoardSessionInput): Promise<{
  createdSession: boolean;
  sessionId: string;
}> {
  const boundSessionId =
    existing?.sessionId ?? persistedBoard?.session.sessionId;
  if (input.sessionId && input.sessionId !== boundSessionId) {
    throw new SessionOwnershipError(
      "session_ownership_conflict",
      "the supplied session is not bound to this board"
    );
  }

  const candidate = boundSessionId;
  const directory = await candidateDirectory(
    context,
    candidate,
    existing,
    input
  );
  if (candidate && directory === null) {
    throw new SessionOwnershipError(
      "session_directory_unknown",
      "the engine could not verify this board's session directory; retry when the engine is available"
    );
  }

  if (
    candidate &&
    directory !== null &&
    !sameDirectory(directory, input.directory)
  ) {
    logger.info("queue-prompt:session-directory-mismatch", {
      boardId: input.boardId,
      candidateDirectory: directory,
      directory: input.directory,
      sessionId: candidate,
    });
    const forked = await context.bridge.forkSession({
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
    let source: "input" | "registry" | "persisted" = "persisted";
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
  const session = await context.bridge.createSession({
    title: input.text.slice(0, 80),
    directory: input.directory,
  });
  logger.info("queue-prompt:session-created", {
    boardId: input.boardId,
    sessionId: session.id,
  });
  return { createdSession: true, sessionId: session.id };
}
