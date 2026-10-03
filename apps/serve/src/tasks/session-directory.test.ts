import { describe, expect, test } from "bun:test";
import {
  boardDirectory,
  resolveSessionDirectory,
  UnknownSessionError,
} from "./session-directory";

/**
 * Follow-up commands — approve, reject, abort, redirect, revert — arrive with a
 * session id and nothing else. Before worktree-per-board every board shared the
 * repo's primary checkout, so the bridge's default directory happened to be
 * right. A board can own a worktree now, and a command routed to the default
 * lands in the wrong tree.
 */

const UNKNOWN_SESSION = /no board owns session/;

function storeWith(
  boards: {
    boardId: string;
    directory: string;
    sessionId?: string;
    worktree?: string;
  }[]
) {
  return {
    getBoardBySessionId: (sessionID: string) => {
      const found = boards.find((board) => board.sessionId === sessionID);
      if (!found) {
        return undefined;
      }
      return {
        boardId: found.boardId,
        repo: {
          directory: found.directory,
          worktree: found.worktree ?? found.directory,
        },
      };
    },
  } as never;
}

describe("resolveSessionDirectory", () => {
  test("a worktree board resolves to its worktree, not the primary checkout", () => {
    const store = storeWith([
      {
        boardId: "board-1",
        directory: "/repos/app",
        sessionId: "sess-1",
        worktree: "/repos/app/.chorus-worktrees/board-1",
      },
    ]);

    expect(resolveSessionDirectory(store, "sess-1")).toBe(
      "/repos/app/.chorus-worktrees/board-1"
    );
  });

  test("a board on the primary checkout resolves to it", () => {
    const store = storeWith([
      { boardId: "board-1", directory: "/repos/app", sessionId: "sess-1" },
    ]);

    expect(resolveSessionDirectory(store, "sess-1")).toBe("/repos/app");
  });

  test("an unknown session is refused rather than defaulted", () => {
    // The whole point: no safe directory exists, and guessing is how a command is
    // applied somewhere the user never intended.
    const store = storeWith([]);
    expect(() => resolveSessionDirectory(store, "sess-ghost")).toThrow(
      UnknownSessionError
    );
    expect(() => resolveSessionDirectory(store, "sess-ghost")).toThrow(
      UNKNOWN_SESSION
    );
  });

  test("two boards on one repo resolve to different directories", () => {
    const store = storeWith([
      { boardId: "board-1", directory: "/repos/app", sessionId: "sess-1" },
      {
        boardId: "board-2",
        directory: "/repos/app",
        sessionId: "sess-2",
        worktree: "/repos/app/.chorus-worktrees/board-2",
      },
    ]);

    expect(resolveSessionDirectory(store, "sess-1")).not.toBe(
      resolveSessionDirectory(store, "sess-2")
    );
  });
});

describe("boardDirectory", () => {
  test("prefers the worktree when the board has one", () => {
    expect(
      boardDirectory({
        repo: {
          directory: "/repos/app",
          worktree: "/repos/app/.chorus-worktrees/b",
        },
      } as never)
    ).toBe("/repos/app/.chorus-worktrees/b");
  });
});
