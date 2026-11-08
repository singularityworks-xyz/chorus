import type { Columns, Task } from "@/features/kanban/components/kanban";

export interface KanbanHistoryEntry {
  boardId: string;
  columnsAfter: Columns;
  columnsBefore: Columns;
  prompt: string;
  task: Task;
  timestamp: number;
}

export interface KanbanHistoryState {
  redo: KanbanHistoryEntry[];
  undo: KanbanHistoryEntry[];
}

export const EMPTY_KANBAN_HISTORY: KanbanHistoryState = {
  redo: [],
  undo: [],
};

const MAX_HISTORY = 50;
const MAX_TRACKED_BOARDS = 100;

function retainRecentBoards(state: KanbanHistoryState): KanbanHistoryState {
  const activity = new Map<string, number>();
  for (const entry of [...state.undo, ...state.redo]) {
    activity.set(
      entry.boardId,
      Math.max(activity.get(entry.boardId) ?? 0, entry.timestamp)
    );
  }
  if (activity.size <= MAX_TRACKED_BOARDS) {
    return state;
  }

  const evictedBoardIds = new Set(
    [...activity.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, activity.size - MAX_TRACKED_BOARDS)
      .map(([boardId]) => boardId)
  );
  return {
    redo: state.redo.filter((entry) => !evictedBoardIds.has(entry.boardId)),
    undo: state.undo.filter((entry) => !evictedBoardIds.has(entry.boardId)),
  };
}

function lastEntryIndexForBoard(
  entries: KanbanHistoryEntry[],
  boardId: string
): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.boardId === boardId) {
      return index;
    }
  }
  return -1;
}

function retainBoardHistory(
  entries: KanbanHistoryEntry[],
  boardId: string
): KanbanHistoryEntry[] {
  const boardEntries = entries.filter(
    (candidate) => candidate.boardId === boardId
  );
  const expiredCount = Math.max(0, boardEntries.length - MAX_HISTORY);
  if (expiredCount === 0) {
    return entries;
  }

  const expired = new Set(boardEntries.slice(0, expiredCount));
  return entries.filter((candidate) => !expired.has(candidate));
}

export function canUndoKanbanHistory(
  state: KanbanHistoryState,
  boardId: string
): boolean {
  return lastEntryIndexForBoard(state.undo, boardId) !== -1;
}

export function canRedoKanbanHistory(
  state: KanbanHistoryState,
  boardId: string
): boolean {
  return lastEntryIndexForBoard(state.redo, boardId) !== -1;
}

export function recordKanbanHistory(
  state: KanbanHistoryState,
  entry: KanbanHistoryEntry
): KanbanHistoryState {
  const undo = retainBoardHistory([...state.undo, entry], entry.boardId);
  return retainRecentBoards({
    redo: state.redo.filter((candidate) => candidate.boardId !== entry.boardId),
    undo,
  });
}

export function undoKanbanHistory(
  state: KanbanHistoryState,
  boardId: string
): { entry: KanbanHistoryEntry; state: KanbanHistoryState } | null {
  const index = lastEntryIndexForBoard(state.undo, boardId);
  if (index === -1) {
    return null;
  }

  const entry = state.undo[index];
  if (!entry) {
    return null;
  }

  const movedEntry = { ...entry, timestamp: Date.now() };
  return {
    entry,
    state: retainRecentBoards({
      redo: retainBoardHistory([...state.redo, movedEntry], boardId),
      undo: state.undo.filter(
        (_candidate, candidateIndex) => candidateIndex !== index
      ),
    }),
  };
}

export function redoKanbanHistory(
  state: KanbanHistoryState,
  boardId: string
): { entry: KanbanHistoryEntry; state: KanbanHistoryState } | null {
  const index = lastEntryIndexForBoard(state.redo, boardId);
  if (index === -1) {
    return null;
  }

  const entry = state.redo[index];
  if (!entry) {
    return null;
  }

  const movedEntry = { ...entry, timestamp: Date.now() };
  const undo = retainBoardHistory([...state.undo, movedEntry], boardId);
  return {
    entry,
    state: retainRecentBoards({
      redo: state.redo.filter(
        (_candidate, candidateIndex) => candidateIndex !== index
      ),
      undo,
    }),
  };
}
