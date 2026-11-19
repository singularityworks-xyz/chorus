import type { Columns, Task, WorkspaceBoard } from "../base";
import type { WorkspaceColumnId } from "../events";
import { WORKSPACE_COLUMN_IDS } from "../events";

function emptyColumns(): Columns {
  return { queue: [], in_progress: [], approve: [], done: [] };
}

export function normalizeColumns(columns: Columns): Columns {
  const next = emptyColumns();
  for (const columnId of WORKSPACE_COLUMN_IDS) {
    next[columnId] = columns[columnId] ?? [];
  }
  return next;
}

export function withTaskUpdated(
  columns: Columns,
  taskId: string,
  updater: (task: Task) => Task
): Columns {
  let changed = false;
  const next: Columns = {};

  for (const [columnId, tasks] of Object.entries(columns)) {
    next[columnId] = tasks.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      const updated = updater(task);
      if (updated !== task) {
        changed = true;
      }
      return updated;
    });
  }

  return changed ? next : columns;
}

export function findTaskInColumns(
  columns: Columns,
  taskId: string
): Task | null {
  for (const tasks of Object.values(columns)) {
    const found = tasks.find((task) => task.id === taskId);
    if (found) {
      return found;
    }
  }
  return null;
}

function findTaskColumn(
  columns: Columns,
  taskId: string
): WorkspaceColumnId | null {
  for (const columnId of WORKSPACE_COLUMN_IDS) {
    if ((columns[columnId] ?? []).some((task) => task.id === taskId)) {
      return columnId;
    }
  }
  return null;
}

export function makeLabelVariant(
  columnId: WorkspaceColumnId
): Task["labelVariant"] {
  switch (columnId) {
    case "approve":
      return "warning-light";
    case "done":
      return "success-light";
    case "in_progress":
      return "primary-light";
    default:
      return "info-light";
  }
}

export function moveCard(
  columns: Columns,
  taskId: string,
  targetColumn: WorkspaceColumnId
): Columns {
  const task = findTaskInColumns(columns, taskId);
  if (!task) {
    return columns;
  }

  const sourceColumn = findTaskColumn(columns, taskId);
  if (sourceColumn === targetColumn) {
    return columns;
  }

  const next: Columns = { ...columns };
  for (const columnId of WORKSPACE_COLUMN_IDS) {
    next[columnId] = (columns[columnId] ?? []).filter(
      (entry) => entry.id !== taskId
    );
  }
  next[targetColumn] = [
    ...next[targetColumn],
    { ...task, labelVariant: makeLabelVariant(targetColumn) },
  ];

  return next;
}

export function reorderCard(
  columns: Columns,
  taskId: string,
  columnId: WorkspaceColumnId,
  beforeTaskId: string | null
): Columns {
  const tasks = columns[columnId] ?? [];
  const taskIndex = tasks.findIndex((task) => task.id === taskId);
  if (taskIndex === -1 || beforeTaskId === taskId) {
    return columns;
  }

  const reordered = [...tasks];
  const [task] = reordered.splice(taskIndex, 1);
  const insertionIndex =
    beforeTaskId === null
      ? reordered.length
      : reordered.findIndex((entry) => entry.id === beforeTaskId);
  if (!task || insertionIndex === -1) {
    return columns;
  }

  reordered.splice(insertionIndex, 0, task);
  if (reordered.every((entry, index) => entry === tasks[index])) {
    return columns;
  }

  return { ...columns, [columnId]: reordered };
}

export function withColumns(
  board: WorkspaceBoard,
  columns: Columns
): WorkspaceBoard {
  return columns === board.columns ? board : { ...board, columns };
}

export function taskNeedsManualReview(
  task: Task | null | undefined,
  boardReviewMode: WorkspaceBoard["reviewMode"]
): boolean {
  const reviewMode = task?.promptInput?.reviewMode ?? boardReviewMode;
  return reviewMode === "manual" && task?.reviewApproved !== true;
}
