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

/**
 * Rebinds a board to a session forked from its current one.
 *
 * A fork replaces the board's session, but nothing recorded that. Follow-up
 * commands look the board up by session id, so an unbound fork made every later
 * command for the new session fail as unknown, and its agent events had no board
 * to attach to. The fork is the board's session from here on.
 *
 * Best-effort: a failure is not fatal to the redirect that triggered it, and the
 * alternative — refusing the fork — would be worse than a session the next
 * command cannot resolve.
 */
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
