import type { WorkspaceBoard } from "@chorus/contracts";
import type { WorkspaceStore } from "../workspace/store";

export class UnknownSessionError extends Error {
  readonly sessionID: string;

  constructor(sessionID: string) {
    super(
      `no board owns session ${sessionID}. Refusing to guess a working directory.`
    );
    this.name = "UnknownSessionError";
    this.sessionID = sessionID;
  }
}

export function resolveSessionDirectory(
  store: WorkspaceStore,
  sessionID: string
): string {
  const board = store.getBoardBySessionId(sessionID);

  if (!board) {
    throw new UnknownSessionError(sessionID);
  }

  return boardDirectory(board);
}

export function boardDirectory(board: WorkspaceBoard): string {
  return board.repo.worktree ?? board.repo.directory;
}

export async function attachForkedSession(
  store: WorkspaceStore,
  previousSessionID: string,
  forkedSessionID: string
): Promise<boolean> {
  const board = store.getBoardBySessionId(previousSessionID);
  if (!board) {
    return false;
  }

  await store.updateBoardSession(board.boardId, {
    sessionId: forkedSessionID,
    state: "active",
  });
  return true;
}
