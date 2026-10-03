import type { WorkspaceBoard } from "@chorus/contracts";
import type { WorkspaceStore } from "../workspace/store";

/**
 * A follow-up command named a session the server cannot place.
 *
 * Thrown rather than falling back to a default directory: every caller is about to
 * tell the engine where to work, and guessing there is how a command ends up
 * applied to the wrong checkout — or to no session at all.
 */
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

/**
 * The working directory for a command addressed to a session.
 *
 * Follow-up commands — an approval reply, a question answer, an abort, a
 * redirect, a revert — arrive with only a session id. Before worktree-per-board
 * every board shared the repo's primary checkout, so the bridge's default
 * directory happened to be right. Now a board may own a worktree, and a command
 * routed to the default directory lands in the wrong tree or on a session the
 * engine cannot place there at all.
 *
 * One resolver for all of them, so no route can quietly keep the old behaviour.
 */
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

/** A board's checkout: its worktree when it has one, else the primary. */
export function boardDirectory(board: WorkspaceBoard): string {
  return board.repo.worktree ?? board.repo.directory;
}
