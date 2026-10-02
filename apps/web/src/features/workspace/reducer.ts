import {
  applyEventToBoard,
  applyEventToWorkspace,
  type WorkspaceBoard,
  type WorkspaceEvent,
  type WorkspacePreferences,
} from "@chorus/contracts";
import type { WorkspaceHistoryEntry } from "./types";

/**
 * Client workspace reducer (plan P5 task 4).
 *
 * Two rules shape this file:
 *
 * - **One projector.** Every server change is folded in through
 *   `applyEventToBoard` / `applyEventToWorkspace` from `packages/contracts`.
 *   Re-implementing board reduction in the client is precisely the server/client
 *   drift the plan names as risk #4, and it stays invisible until the UI renders
 *   wrong state.
 * - **The server wins.** An optimistic drag is a local guess until the server
 *   confirms it. Any event for that board replaces the guess, and a 5 s deadline
 *   clears it so a dropped mutation cannot pin a board in the wrong place.
 */

export interface PendingDrag {
  expiresAt: number;
  mutationId: string;
  position: { x: number; y: number };
}

export interface WorkspaceState {
  boards: WorkspaceBoard[];
  /** One in-flight optimistic position per board, keyed by board id. */
  pendingDrags: Map<string, PendingDrag>;
  preferences: WorkspacePreferences;
  /**
   * Recently used boards.
   *
   * Not in the versioned snapshot the socket sends (spec §5 defines the blob as
   * boards, preferences, and selection), so it is maintained client-side from
   * board lifecycle events rather than being clobbered by every snapshot.
   */
  previousWorkspaces: WorkspaceHistoryEntry[];
  selectedBoardId: string | null;
}

/** Optimistic drift is abandoned rather than left pinned. */
export const DRAG_TIMEOUT_MS = 5000;

/** Keeps the recents list bounded. */
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

/**
 * Records a board in the recents list.
 *
 * Keyed on the repo directory rather than the board id, so reopening the same
 * repository replaces its entry instead of stacking duplicates.
 */
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

/**
 * Folds one event into the board list.
 *
 * Returns `null` for workspace-scoped events, which have nothing to say about a
 * specific board. `board.created` and `board.removed` are handled here rather
 * than by the shared projector on purpose: that projector operates on one board
 * and deliberately treats both as no-ops, because adding to and removing from
 * the list is the caller's job.
 */
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

  // The server is authoritative, but only an event that carries a position can
  // answer the guess. Server events are ordered, so anything else for this board
  // was emitted before the server saw the `board.move` and says nothing about
  // it -- settling on those would snap a dropped card back to its old position
  // within milliseconds, then jump forward again when `board.moved` lands. That
  // is the exact flicker the optimistic guess exists to prevent. A dropped
  // mutation is covered by the five-second sweeper instead.
  if (event.type === "board.moved" || event.type === "board.removed") {
    pendingDrags = withoutPending(pendingDrags, boardId) ?? pendingDrags;
  }

  if (event.type === "board.created") {
    // The event carries the whole board, so nothing is reconstructed here — there
    // is no second place for board construction to drift.
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
      // The board is gone, so its recents entry would offer to reopen something
      // the operator just deleted.
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

/**
 * Folds sequenced events onto the state.
 *
 * Precondition: `events` contains each sequence at most once, and nothing the
 * caller has already applied via `server/snapshot`. The projector is not
 * idempotent -- `card.created` appends and `step.delta_appended` concatenates --
 * so a duplicate here is visible duplicated state, not a no-op. The transport
 * enforces this by filtering buffered events against the snapshot's sequence
 * before they reach this function.
 */
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

    // Workspace-scoped events (selection, preferences) go through the same
    // shared reducer so the client cannot grow its own preference logic.
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
      // Recents survive: the versioned blob does not carry them, so clearing
      // would empty the list the first time the server answered.
      return {
        ...state,
        boards: action.boards,
        // Every guess is abandoned — the snapshot is the truth for all boards.
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

/**
 * The position a board should render at.
 *
 * The optimistic guess wins while it is live, because that is the point of
 * applying it locally — otherwise a drag would visibly snap back and forward.
 */
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

/**
 * Drops guesses whose deadline has passed.
 *
 * A mutation that never got a matching event would otherwise pin the board in
 * the wrong place for the rest of the session.
 */
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
