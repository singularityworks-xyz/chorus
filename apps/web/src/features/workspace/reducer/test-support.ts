import type { WorkspaceBoard, WorkspaceEvent } from "@chorus/contracts";
import { INITIAL_WORKSPACE_STATE, type WorkspaceState } from "../reducer";

function board(
  id: string,
  overrides: Partial<WorkspaceBoard> = {}
): WorkspaceBoard {
  return {
    boardId: id,
    columns: { approve: [], done: [], in_progress: [], queue: [] },
    modelSelection: null,
    position: { x: 0, y: 0 },
    repo: {
      directory: `/repos/${id}`,
      projectId: undefined,
      sandboxes: [],
      worktree: `/repos/${id}`,
    },
    reviewMode: "auto",
    session: { state: "uninitialized" },
    title: id,
    ...overrides,
  };
}
function withBoards(boards: WorkspaceBoard[]): WorkspaceState {
  return { ...INITIAL_WORKSPACE_STATE, boards };
}
function created(target: WorkspaceBoard, ts = 1): WorkspaceEvent {
  return { board: target, boardId: target.boardId, ts, type: "board.created" };
}
function movedTo(x: number, y: number): WorkspaceEvent {
  return {
    boardId: "board-1",
    position: { x, y },
    ts: 1000,
    type: "board.moved",
  };
}

export { board, created, movedTo, withBoards };
