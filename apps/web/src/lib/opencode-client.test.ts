import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchCommands,
  fetchDirectory,
  fetchFiles,
  fetchGitStatus,
  fetchSessionDiff,
} from "./opencode-client";

const originalFetch = globalThis.fetch;

function replaceFetch(
  handler: (input: Parameters<typeof fetch>[0]) => Promise<Response>
): void {
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0]) => handler(input),
    { preconnect: originalFetch.preconnect }
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("board autocomplete client", () => {
  test("requests suggestions through the authenticated board proxy", async () => {
    let requestedUrl = "";
    replaceFetch((input) => {
      requestedUrl = String(input);
      return Promise.resolve(
        Response.json({
          kind: "commands",
          commands: [{ name: "review", description: "Review changes" }],
        })
      );
    });

    await expect(fetchCommands("board/one")).resolves.toEqual([
      { name: "review", description: "Review changes" },
    ]);
    expect(requestedUrl).toBe(
      "/api/boards/board%2Fone/autocomplete?kind=commands"
    );
  });

  test("validates and maps file entries returned by the board API", async () => {
    replaceFetch(async () =>
      Response.json({
        kind: "directory",
        entries: [{ path: "src/main.ts", type: "file" }],
      })
    );

    await expect(fetchDirectory("board-1", "src")).resolves.toEqual([
      { name: "main.ts", path: "src/main.ts", type: "file" },
    ]);
  });

  test("rejects server errors instead of treating them as empty results", async () => {
    replaceFetch(async () =>
      Response.json(
        {
          code: "autocomplete_unavailable",
          message: "Provider connection unavailable. Retry.",
        },
        { status: 502 }
      )
    );

    await expect(fetchFiles("board-1", "main")).rejects.toThrow(
      "Provider connection unavailable. Retry."
    );
  });
});

describe("session diff client", () => {
  test("validates and returns session diffs", async () => {
    replaceFetch(async () =>
      Response.json([
        {
          additions: 1,
          after: "new line\n",
          before: "old line\n",
          deletions: 1,
          file: "src/main.ts",
        },
      ])
    );

    await expect(fetchSessionDiff("session/one")).resolves.toEqual([
      {
        additions: 1,
        after: "new line\n",
        before: "old line\n",
        deletions: 1,
        file: "src/main.ts",
      },
    ]);
  });

  test("surfaces a Chorus API error instead of returning an empty diff", async () => {
    replaceFetch(async () =>
      Response.json(
        {
          code: "session_unavailable",
          message: "The session is unavailable. Reopen the board and retry.",
        },
        { status: 503 }
      )
    );

    await expect(fetchSessionDiff("session-1")).rejects.toThrow(
      "The session is unavailable. Reopen the board and retry."
    );
  });

  test("rejects malformed diff payloads as an explicit error", async () => {
    replaceFetch(async () => Response.json([{ file: "../outside" }]));

    await expect(fetchSessionDiff("session-1")).rejects.toThrow(
      "The server returned invalid diff data. Try again."
    );
  });
});

describe("repository status client", () => {
  test("validates status and applies contract defaults", async () => {
    let requestedUrl = "";
    replaceFetch((input) => {
      requestedUrl = String(input);
      return Promise.resolve(
        Response.json({ branch: "main", modified: 2, timestamp: 123 })
      );
    });

    await expect(fetchGitStatus("/tmp/repo with spaces")).resolves.toEqual({
      ahead: 0,
      behind: 0,
      branch: "main",
      linesAdded: 0,
      linesRemoved: 0,
      modified: 2,
      staged: 0,
      tracking: undefined,
      untracked: 0,
    });
    expect(requestedUrl).toBe(
      "/api/git/status?directory=%2Ftmp%2Frepo+with+spaces"
    );
  });

  test("surfaces server errors instead of treating them as a clean repository", async () => {
    replaceFetch(async () =>
      Response.json(
        {
          code: "repository_unavailable",
          message: "The repository is unavailable. Retry.",
        },
        { status: 503 }
      )
    );

    await expect(fetchGitStatus("/tmp/repo")).rejects.toThrow(
      "The repository is unavailable. Retry."
    );
  });

  test("rejects malformed status payloads explicitly", async () => {
    replaceFetch(async () => Response.json({ branch: "", modified: "many" }));

    await expect(fetchGitStatus("/tmp/repo")).rejects.toThrow(
      "The server returned invalid repository status. Refresh the board and retry."
    );
  });

  test("returns a recoverable message when the server cannot be reached", async () => {
    replaceFetch(() => Promise.reject(new TypeError("connection refused")));

    await expect(fetchGitStatus("/tmp/repo")).rejects.toThrow(
      "Could not reach Chorus to load repository status. Check the connection and retry."
    );
  });
});
