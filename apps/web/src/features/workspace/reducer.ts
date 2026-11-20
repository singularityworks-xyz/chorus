import {
  applyEventToBoard,
  applyEventToWorkspace,
  type WorkspaceBoard,
  type WorkspaceEvent,
  type WorkspacePreferences,
} from "@chorus/contracts";
import type { WorkspaceHistoryEntry } from "./types";

export interface PendingDrag {
  expiresAt: number;
  mutationId: string;
  position: { x: number; y: number };
}

export interface WorkspaceState {
  boards: WorkspaceBoard[];

  pendingDrags: Map<string, PendingDrag>;
  preferences: WorkspacePreferences;

  previousWorkspaces: WorkspaceHistoryEntry[];
  selectedBoardId: string | null;
}

export const DRAG_TIMEOUT_MS = 5000;

export const MAX_PREVIOUS_WORKSPACES = 8;

export type WorkspaceAction =
  | { events: WorkspaceEvent[]; type: "server/events" }
  | {
      boards: WorkspaceBoard[];
      preferences: WorkspacePreferences;
      selectedBoardId: string | null;
      type: "server/snapshot";
    }
  | {
      boardId: string;
      mutationId: string;
      position: { x: number; y: number };
      type: "optimistic/drag";
    }
  | { boardId: string; type: "optimistic/drag-settle" }
  | { now: number; type: "optimistic/expire-drags" }
  | { mode: WorkspacePreferences["boardViewMode"]; type: "local/view-mode" }
  | { voiceId: string | null; type: "local/voice" }
  | { composerHintDismissed: true; type: "local/hint-dismissed" };

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  boards: [],
  pendingDrags: new Map(),
  preferences: {
    boardViewMode: "relaxed",
    composerHintDismissed: false,
    defaultModelSelection: null,
    recentlyUsedModels: [],
    speechVoiceId: null,
  },
  previousWorkspaces: [],
  selectedBoardId: null,
};

function withPending(
  pendingDrags: Map<string, PendingDrag>,
  boardId: string,
  drag: PendingDrag
): Map<string, PendingDrag> {
  const next = new Map(pendingDrags);
  next.set(boardId, drag);
  return next;
}

function withoutPending(
  pendingDrags: Map<string, PendingDrag>,
  boardId: string
): Map<string, PendingDrag> | null {
  if (!pendingDrags.has(boardId)) {
    return null;
  }

  const next = new Map(pendingDrags);
  next.delete(boardId);
  return next;
}

function noteHistory(
  existing: WorkspaceHistoryEntry[],
  board: WorkspaceBoard
): WorkspaceHistoryEntry[] {
  const entry: WorkspaceHistoryEntry = {
    id: board.boardId,
    lastOpenedAt: Date.now(),
    repo: board.repo,
    title: board.title,
  };

  const without = existing.filter(
    (candidate) => candidate.repo.directory !== board.repo.directory
  );

  return [entry, ...without].slice(0, MAX_PREVIOUS_WORKSPACES);
}

function applyBoardListEvent(
  input: BoardListInput,
  event: WorkspaceEvent
): BoardListInput | null {
  const boardId =
    "boardId" in event && typeof event.boardId === "string"
      ? event.boardId
      : null;

  if (!boardId) {
    return null;
  }

  let { boards, pendingDrags, previousWorkspaces } = input;

  if (event.type === "board.moved" || event.type === "board.removed") {
    pendingDrags = withoutPending(pendingDrags, boardId) ?? pendingDrags;
  }

  if (event.type === "board.created") {
    const alreadyPresent = boards.some(
      (board) => board.boardId === event.board.boardId
    );
    if (!alreadyPresent) {
      boards = [...boards, event.board];
      previousWorkspaces = noteHistory(previousWorkspaces, event.board);
    }
  } else if (event.type === "board.removed") {
    const removed = boards.find((board) => board.boardId === boardId);
    boards = boards.filter((board) => board.boardId !== boardId);
    if (removed) {
      previousWorkspaces = previousWorkspaces.filter(
        (candidate) => candidate.repo.directory !== removed.repo.directory
      );
    }
  } else {
    boards = boards.map((board) => applyEventToBoard(board, event));
  }

  return { boards, pendingDrags, previousWorkspaces };
}

interface BoardListInput {
  boards: WorkspaceBoard[];
  pendingDrags: Map<string, PendingDrag>;
  previousWorkspaces: WorkspaceHistoryEntry[];
}

// Duplicate events append state twice; the sync layer must deduplicate first.
function applyEvents(
  state: WorkspaceState,
  events: WorkspaceEvent[]
): WorkspaceState {
  let boards = state.boards;
  let preferences = state.preferences;
  let selectedBoardId = state.selectedBoardId;
  let previousWorkspaces = state.previousWorkspaces;
  let pendingDrags = state.pendingDrags;

  for (const event of events) {
    const boardList = applyBoardListEvent(
      { boards, pendingDrags, previousWorkspaces },
      event
    );

    if (boardList) {
      boards = boardList.boards;
      pendingDrags = boardList.pendingDrags;
      previousWorkspaces = boardList.previousWorkspaces;
    }

    const scope = applyEventToWorkspace(
      { boards, preferences, selectedBoardId },
      event
    );
    preferences = scope.preferences;
    selectedBoardId = scope.selectedBoardId;
  }

  return {
    boards,
    pendingDrags,
    preferences,
    previousWorkspaces,
    selectedBoardId,
  };
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction
): WorkspaceState {
  switch (action.type) {
    case "server/snapshot": {
      return {
        ...state,
        boards: action.boards,
        pendingDrags: new Map(),
        preferences: action.preferences,
        selectedBoardId: action.selectedBoardId,
      };
    }

    case "server/events": {
      return applyEvents(state, action.events);
    }

    case "optimistic/drag": {
      return {
        ...state,
        pendingDrags: withPending(state.pendingDrags, action.boardId, {
          expiresAt: Date.now() + DRAG_TIMEOUT_MS,
          mutationId: action.mutationId,
          position: action.position,
        }),
      };
    }

    case "optimistic/expire-drags": {
      return expirePendingDrags(state, action.now);
    }

    case "optimistic/drag-settle": {
      const pendingDrags = withoutPending(state.pendingDrags, action.boardId);

      return pendingDrags === null ? state : { ...state, pendingDrags };
    }

    case "local/view-mode": {
      return {
        ...state,
        preferences: { ...state.preferences, boardViewMode: action.mode },
      };
    }

    case "local/voice": {
      return {
        ...state,
        preferences: { ...state.preferences, speechVoiceId: action.voiceId },
      };
    }

    case "local/hint-dismissed": {
      return {
        ...state,
        preferences: {
          ...state.preferences,
          composerHintDismissed: action.composerHintDismissed,
        },
      };
    }

    default: {
      return state;
    }
  }
}

export function displayedPosition(
  board: WorkspaceBoard,
  pendingDrags: Map<string, PendingDrag>,
  now: number
): { x: number; y: number } {
  const drag = pendingDrags.get(board.boardId);

  if (drag && drag.expiresAt > now) {
    return drag.position;
  }

  return board.position;
}

export function expirePendingDrags(
  state: WorkspaceState,
  now: number
): WorkspaceState {
  const stale = [...state.pendingDrags].filter(
    ([, drag]) => drag.expiresAt > 0 && drag.expiresAt <= now
  );

  if (stale.length === 0) {
    return state;
  }

  const pendingDrags = new Map(state.pendingDrags);
  for (const [boardId] of stale) {
    pendingDrags.delete(boardId);
  }

  return { ...state, pendingDrags };
}
