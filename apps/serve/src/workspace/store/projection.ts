import {
  applyEventToBoard,
  type BoardSeed,
  type WorkspaceBoard,
  type WorkspaceEvent,
  type WorkspaceHistoryEntry,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotInput,
  workspaceBoardSchema,
} from "@chorus/contracts";

const BOARD_X_OFFSET = 180;
const BOARD_Y_OFFSET = 120;
const BOARD_X_START = 120;
const BOARD_Y_START = 120;

export const EMPTY_PREFERENCES: WorkspaceSnapshotInput["preferences"] = {
  boardViewMode: "relaxed",
  composerHintDismissed: false,
  defaultModelSelection: null,
  recentlyUsedModels: [],
  speechVoiceId: null,
};

function createHistoryId(board: Pick<WorkspaceBoard, "repo">): string {
  return board.repo.projectId ?? board.repo.worktree ?? board.repo.directory;
}

function createHistoryEntry(board: WorkspaceBoard): WorkspaceHistoryEntry {
  return {
    id: createHistoryId(board),
    title: board.title,
    lastOpenedAt: Date.now(),
    repo: board.repo,
  };
}

function sortHistory(
  entries: WorkspaceHistoryEntry[]
): WorkspaceHistoryEntry[] {
  return [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function createBoardFromSeed(
  seed: BoardSeed,
  index: number
): WorkspaceBoard {
  return workspaceBoardSchema.parse({
    boardId: crypto.randomUUID(),
    title: seed.title,
    repo: seed.repo,
    position: {
      x: BOARD_X_START + index * BOARD_X_OFFSET,
      y: BOARD_Y_START + index * BOARD_Y_OFFSET,
    },
    columns: { queue: [], in_progress: [], approve: [], done: [] },
    reviewMode: "auto",
    modelSelection: null,
    session: { state: "uninitialized" },
  });
}

function canonical<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withHistory(
  snapshot: WorkspaceSnapshot,
  boards: WorkspaceBoard[]
): WorkspaceSnapshot {
  const historyById = new Map(
    snapshot.previousWorkspaces.map((entry) => [entry.id, entry])
  );

  for (const board of boards) {
    historyById.set(createHistoryId(board), createHistoryEntry(board));
  }

  return {
    ...snapshot,
    boards,
    previousWorkspaces: sortHistory([...historyById.values()]),
  };
}

function applyWorkspacePreference(
  snapshot: WorkspaceSnapshot,
  event: WorkspaceEvent
): WorkspaceSnapshot {
  if (event.type === "preference.composer_hint_dismissed") {
    return {
      ...snapshot,
      preferences: { ...snapshot.preferences, composerHintDismissed: true },
    };
  }

  if (event.type === "preference.speech_voice_set") {
    return {
      ...snapshot,
      preferences: { ...snapshot.preferences, speechVoiceId: event.voiceId },
    };
  }

  if (event.type === "preference.board_view_mode_set") {
    return {
      ...snapshot,
      preferences: { ...snapshot.preferences, boardViewMode: event.mode },
    };
  }

  if (event.type === "preference.default_model_set") {
    return {
      ...snapshot,
      preferences: {
        ...snapshot.preferences,
        defaultModelSelection: event.model,
      },
    };
  }

  return snapshot;
}

export function projectWorkspaceEvent(
  snapshot: WorkspaceSnapshot,
  event: WorkspaceEvent
): WorkspaceSnapshot {
  switch (event.type) {
    case "board.created":
      return {
        ...snapshot,
        boards: [...snapshot.boards, event.board],
        selectedBoardId: event.board.boardId,
      };

    case "board.removed": {
      const boards = snapshot.boards.filter(
        (board) => board.boardId !== event.boardId
      );
      return {
        ...snapshot,
        boards,
        selectedBoardId:
          snapshot.selectedBoardId === event.boardId
            ? (boards[0]?.boardId ?? null)
            : snapshot.selectedBoardId,
      };
    }

    case "board.selected":
      return { ...snapshot, selectedBoardId: event.boardId };

    case "board.task_plan_updated": {
      const boards = snapshot.boards.map((board) =>
        board.boardId === event.boardId
          ? applyEventToBoard(board, event)
          : board
      );
      return withHistory(snapshot, boards);
    }

    case "preference.recent_model_added": {
      const recentModels = (
        snapshot.preferences.recentlyUsedModels ?? []
      ).filter(
        (model) =>
          model.providerID !== event.model.providerID ||
          model.modelID !== event.model.modelID
      );
      return {
        ...snapshot,
        preferences: {
          ...snapshot.preferences,
          recentlyUsedModels: [event.model, ...recentModels].slice(0, 5),
        },
      };
    }

    case "preference.composer_hint_dismissed":
    case "preference.speech_voice_set":
    case "preference.board_view_mode_set":
    case "preference.default_model_set":
      return applyWorkspacePreference(snapshot, event);

    default: {
      if (!("boardId" in event) || event.boardId === null) {
        return snapshot;
      }

      const boards = snapshot.boards.map((board) =>
        board.boardId === event.boardId
          ? canonical(applyEventToBoard(board, event))
          : board
      );

      return boards.some((board, index) => board !== snapshot.boards[index])
        ? withHistory(snapshot, boards)
        : snapshot;
    }
  }
}

export function boardIdOf(event: WorkspaceEvent): string | null {
  return "boardId" in event ? event.boardId : null;
}

export function diffSessionEvent(
  before: WorkspaceBoard,
  after: WorkspaceBoard
): WorkspaceEvent | null {
  if (after.session.sessionId === before.session.sessionId) {
    return null;
  }

  return {
    type: "session.attached",
    boardId: before.boardId,
    sessionId: after.session.sessionId ?? "",
    taskId: before.session.currentTaskId,
    ts: Date.now(),
  };
}
