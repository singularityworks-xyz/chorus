import type { Task, WorkspaceBoard } from "@chorus/contracts";
import { workspaceBoardSchema } from "@chorus/contracts";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";

export const T0 = 1_700_000_000_000;
export const BOARD = "board-1";
export const SESSION = "sess-1";
export const TASK = "task-1";

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK,
    label: "repo",
    labelVariant: "primary-light",
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
    session: { currentTaskId: TASK, sessionId: SESSION, state: "active" },
    title: "Repo",
    ...overrides,
  });
}

export function agentEvent(
  overrides: Partial<NormalizedAgentEvent>
): NormalizedAgentEvent {
  return {
    sessionID: SESSION,
    timestamp: T0,
    type: "message.part.updated",
    ...overrides,
  };
}

export function column(
  board: WorkspaceBoard,
  columnId: keyof WorkspaceBoard["columns"]
) {
  return board.columns[columnId] ?? [];
}

export function stepsOf(
  board: WorkspaceBoard,
  columnId: keyof WorkspaceBoard["columns"] = "in_progress"
) {
  return column(board, columnId)[0]?.run?.steps ?? [];
}
