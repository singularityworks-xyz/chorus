import { describe, expect, test } from "bun:test";
import {
  loadBoardSessionHistory,
  sendBoardSessionHistoryCommand,
} from "./board-session-history-client";

function historyResponse({
  boardId = "board-1",
  canRedo = false,
  canUndo = true,
  sessionId = "session-1",
}: {
  boardId?: string;
  canRedo?: boolean;
  canUndo?: boolean;
  sessionId?: string | null;
} = {}) {
  return new Response(
    JSON.stringify({
      boardId,
      canRedo,
      canUndo,
      busy: false,
      sessionId,
      timestamp: 1,
    }),
    { status: 200 }
  );
}

function commandResponse({
  boardId = "board-1",
  command = "undo",
}: {
  boardId?: string;
  command?: "undo" | "redo";
} = {}) {
  return new Response(
    JSON.stringify({
      accepted: true,
      boardId,
      command,
      sessionId: "session-1",
      timestamp: 1,
    }),
    { status: 200 }
  );
}

describe("board session history client", () => {
  test("loads board-scoped history with a bounded no-cache request", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const history = await loadBoardSessionHistory("board / one", "session-1", {
      fetcher: (input, init) => {
        requestUrl = input instanceof Request ? input.url : String(input);
        requestInit = init;
        return Promise.resolve(historyResponse({ boardId: "board / one" }));
      },
    });

    expect(requestUrl).toBe("/api/boards/board%20%2F%20one/session/history");
    expect(requestInit?.cache).toBe("no-store");
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(history.canUndo).toBe(true);

    const emptyHistory = await loadBoardSessionHistory("board-2", undefined, {
      fetcher: () =>
        Promise.resolve(
          historyResponse({
            boardId: "board-2",
            canUndo: false,
            sessionId: null,
          })
        ),
    });
    expect(emptyHistory.sessionId).toBeNull();
    expect(emptyHistory.canUndo).toBe(false);
  });

  test("rejects history for another board or session", async () => {
    await expect(
      loadBoardSessionHistory("board-1", "session-1", {
        fetcher: () => Promise.resolve(historyResponse({ boardId: "board-2" })),
      })
    ).rejects.toThrow("did not match this board");

    await expect(
      loadBoardSessionHistory("board-1", "session-1", {
        fetcher: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                boardId: "board-1",
                canRedo: false,
                canUndo: "yes",
                busy: false,
                sessionId: "session-1",
                timestamp: 1,
              }),
              { status: 200 }
            )
          ),
      })
    ).rejects.toThrow("did not match this board");

    await expect(
      loadBoardSessionHistory("board-1", "session-2", {
        fetcher: () => Promise.resolve(historyResponse()),
      })
    ).rejects.toThrow("did not match this board");
  });

  test("preserves server errors and normalizes timeouts and disconnections", async () => {
    await expect(
      loadBoardSessionHistory("board-1", "session-1", {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              code: "history_unavailable",
              message: "The board is still starting.",
            }),
            { status: 503 }
          ),
      })
    ).rejects.toThrow("The board is still starting.");

    await expect(
      loadBoardSessionHistory("board-1", "session-1", {
        fetcher: () =>
          Promise.reject(new DOMException("Timed out", "TimeoutError")),
      })
    ).rejects.toThrow("took too long to respond");

    await expect(
      loadBoardSessionHistory("board-1", "session-1", {
        fetcher: () => Promise.reject(new TypeError("Failed to fetch")),
      })
    ).rejects.toThrow("Could not reach Chorus");
  });

  test("sends a bounded command to the requested board and verifies its acknowledgment", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const result = await sendBoardSessionHistoryCommand("board/one", "redo", {
      fetcher: (input, init) => {
        requestUrl = input instanceof Request ? input.url : String(input);
        requestInit = init;
        return Promise.resolve(
          commandResponse({ boardId: "board/one", command: "redo" })
        );
      },
    });

    expect(requestUrl).toBe("/api/boards/board%2Fone/session/history/redo");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(result.command).toBe("redo");
  });

  test("rejects mismatched acknowledgments and preserves server rejections", async () => {
    await expect(
      sendBoardSessionHistoryCommand("board-1", "undo", {
        fetcher: () => Promise.resolve(commandResponse({ boardId: "board-2" })),
      })
    ).rejects.toThrow("did not confirm the history change");

    await expect(
      sendBoardSessionHistoryCommand("board-1", "undo", {
        fetcher: () => Promise.resolve(commandResponse({ command: "redo" })),
      })
    ).rejects.toThrow("did not confirm the history change");

    await expect(
      sendBoardSessionHistoryCommand("board-1", "undo", {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              code: "session_busy",
              message: "Finish the running task first.",
            }),
            { status: 409 }
          ),
      })
    ).rejects.toThrow("Finish the running task first.");
  });

  test("keeps unauthorized responses and ambiguous failures actionable", async () => {
    let unauthorizedResponse: Response | null = null;
    await expect(
      sendBoardSessionHistoryCommand("board-1", "undo", {
        onUnauthorized: (response) => {
          unauthorizedResponse = response;
          return true;
        },
        fetcher: () => Promise.resolve(new Response(null, { status: 401 })),
      })
    ).rejects.toThrow("Your sign-in expired");
    expect(unauthorizedResponse).toBeInstanceOf(Response);

    await expect(
      sendBoardSessionHistoryCommand("board-1", "redo", {
        fetcher: () =>
          Promise.reject(new DOMException("Timed out", "TimeoutError")),
      })
    ).rejects.toThrow("may still have completed");

    await expect(
      sendBoardSessionHistoryCommand("board-1", "undo", {
        fetcher: () => Promise.reject(new TypeError("Failed to fetch")),
      })
    ).rejects.toThrow("Check repository history before retrying");
  });
});
