import { afterEach, describe, expect, test } from "bun:test";
import { fetchCommands, fetchDirectory, fetchFiles } from "./opencode-client";

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
