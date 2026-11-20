import type { WorkspaceBoard } from "../base/boards";
import { workspaceBoardSchema } from "../base/boards";
import type { Task } from "../base/tasks";
import type { WorkspaceColumnId } from "../events";

export const T0 = 1_700_000_000_000;
export const BOARD = "board-1";
export const TASK = "task-1";

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK,
    label: "repo",
    labelVariant: "info-light",
    title: "Fix the bug",
    ...overrides,
  };
}

export function makeBoard(
  overrides: Partial<WorkspaceBoard> = {}
): WorkspaceBoard {
  return workspaceBoardSchema.parse({
    boardId: BOARD,
    columns: {
      queue: [],
      in_progress: [makeTask()],
      approve: [],
      done: [],
    },
    modelSelection: null,
    position: { x: 0, y: 0 },
    repo: { directory: "/tmp/repo", worktree: "/tmp/repo" },
    reviewMode: "auto",
    session: { currentTaskId: TASK, sessionId: "sess-1", state: "active" },
    title: "Repo",
    ...overrides,
  });
}

export function columnOf(
  board: WorkspaceBoard,
  columnId: WorkspaceColumnId
): Task[] {
  return board.columns[columnId] ?? [];
}

export function laneOf(
  board: WorkspaceBoard,
  taskId: string
): WorkspaceColumnId | null {
  for (const lane of ["queue", "in_progress", "approve", "done"] as const) {
    if (columnOf(board, lane).some((task) => task.id === taskId)) {
      return lane;
    }
  }
  return null;
}
