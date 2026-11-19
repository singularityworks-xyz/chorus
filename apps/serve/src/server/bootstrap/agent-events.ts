import type { Logger } from "@chorus/logger";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { SessionWatchdog } from "../../tasks/session-watchdog";
import type { WorkspaceStore } from "../../workspace/store";

function updateWatchdog(
  event: NormalizedAgentEvent,
  workspaceStore: WorkspaceStore,
  watchdog: SessionWatchdog
): void {
  const sessionId = event.sessionID;
  if (!sessionId) {
    return;
  }
  if (event.activity === "error" || event.activity === "idle") {
    watchdog.stop(sessionId);
    return;
  }
  if (event.activity !== "thinking" && event.activity !== "writing") {
    watchdog.reset(sessionId);
    return;
  }

  const board = workspaceStore.getBoardBySessionId(sessionId);
  if (board?.session.currentTaskId) {
    watchdog.observeActivity(sessionId, {
      boardId: board.boardId,
      directory: board.repo.worktree ?? board.repo.directory,
    });
  } else {
    watchdog.reset(sessionId);
  }
}

export function subscribeToAgentEvents({
  bridge,
  logger,
  watchdog,
  workspaceStore,
}: {
  bridge: OpenCodeBridge;
  logger: Logger;
  watchdog: SessionWatchdog;
  workspaceStore: WorkspaceStore;
}): void {
  let lastLoggedWorkspaceCommitSeq = 0;
  bridge.subscribe(async (event) => {
    if (event.type === "server.heartbeat") {
      return;
    }

    logger.debug("bridge-event", {
      type: event.type,
      ...(event.sessionID && { sessionID: event.sessionID }),
      ...(event.activity && { activity: event.activity }),
    });

    if (!(event.sessionID && (event.activity || event.delta))) {
      return;
    }

    updateWatchdog(event, workspaceStore, watchdog);

    const commit = await workspaceStore.applyAgentEvent(event);
    if (!commit || commit.lastSeq <= lastLoggedWorkspaceCommitSeq) {
      return;
    }
    lastLoggedWorkspaceCommitSeq = commit.lastSeq;

    logger.info("workspace-commit", {
      boardId: commit.boardId,
      seq: commit.lastSeq,
      events: commit.events.map((entry) => entry.type),
      ...(commit.boardId && event.sessionID
        ? { sessionID: event.sessionID }
        : {}),
    });
  });
}
