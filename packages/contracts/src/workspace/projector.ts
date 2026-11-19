import type { WorkspaceBoard, WorkspaceSnapshotInput } from "./base/boards";
import type { ModelSelection } from "./base/models";
import type { WorkspaceEvent } from "./events";
import { isBoardScopedEvent } from "./events";
import { applyBoardScopedEvent } from "./projector/board-events";
import { isCardRunStepEvent, isSessionScopedEvent } from "./projector/routing";
import { applySessionEvent } from "./projector/session-events";
import { applyCardEvent } from "./projector/task-events";

export function applyEventToBoard(
  board: WorkspaceBoard,
  event: WorkspaceEvent
): WorkspaceBoard {
  if (!isBoardScopedEvent(event) || event.boardId !== board.boardId) {
    return board;
  }

  if (isSessionScopedEvent(event)) {
    return applySessionEvent(board, event);
  }

  if (isCardRunStepEvent(event)) {
    return applyCardEvent(board, event, event.ts);
  }

  return applyBoardScopedEvent(board, event);
}

export function applyEventToWorkspace(
  workspace: WorkspaceSnapshotInput,
  event: WorkspaceEvent
): WorkspaceSnapshotInput {
  switch (event.type) {
    case "board.selected":
      return { ...workspace, selectedBoardId: event.boardId };

    case "board.removed":
      return workspace.selectedBoardId === event.boardId
        ? {
            ...workspace,
            selectedBoardId:
              workspace.boards.find((board) => board.boardId !== event.boardId)
                ?.boardId ?? null,
          }
        : workspace;

    case "preference.composer_hint_dismissed":
      return {
        ...workspace,
        preferences: { ...workspace.preferences, composerHintDismissed: true },
      };

    case "preference.speech_voice_set":
      return {
        ...workspace,
        preferences: { ...workspace.preferences, speechVoiceId: event.voiceId },
      };

    case "preference.default_model_set":
      return {
        ...workspace,
        preferences: {
          ...workspace.preferences,
          defaultModelSelection: event.model,
        },
      };

    case "preference.board_view_mode_set":
      return {
        ...workspace,
        preferences: { ...workspace.preferences, boardViewMode: event.mode },
      };

    case "preference.recent_model_added": {
      const existing = workspace.preferences.recentlyUsedModels ?? [];
      const withoutDuplicate = existing.filter(
        (model: ModelSelection) =>
          model.providerID !== event.model.providerID ||
          model.modelID !== event.model.modelID
      );
      return {
        ...workspace,
        preferences: {
          ...workspace.preferences,
          recentlyUsedModels: [event.model, ...withoutDuplicate].slice(0, 10),
        },
      };
    }

    default:
      return workspace;
  }
}

export function attachSession(
  board: WorkspaceBoard,
  sessionId: string,
  now: number
): WorkspaceBoard {
  return applyEventToBoard(board, {
    type: "session.attached",
    boardId: board.boardId,
    sessionId,
    taskId: board.session.currentTaskId,
    ts: now,
  });
}

export function applyEventToBoards(
  boards: WorkspaceBoard[],
  event: WorkspaceEvent
): WorkspaceBoard[] {
  if (!("boardId" in event) || event.boardId === null) {
    return boards;
  }

  let changed = false;
  const next = boards.map((board) => {
    const updated = applyEventToBoard(board, event);
    if (updated !== board) {
      changed = true;
    }
    return updated;
  });

  return changed ? next : boards;
}
