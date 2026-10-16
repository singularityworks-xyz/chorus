import { describe, expect, mock, test } from "bun:test";
import { SessionManager } from "./session-manager";

/**
 * The generated client does not throw on a failed request — it resolves with
 * `{ error }` and `data` undefined. Every call site that ignores the result
 * therefore reports success for a request the engine refused, which is how a
 * prompt that never landed came back as `accepted: true`.
 *
 * These pin the two paths a queued prompt depends on.
 */

const PROMPT_FAILED = /promptAsync failed/;
const CREATE_FAILED = /session.create failed/;
const CONNECTION_REFUSED = /ConnectionRefused/;

function clientReturning(result: unknown) {
  return {
    session: {
      create: () => Promise.resolve(result),
      promptAsync: () => Promise.resolve(result),
    },
  } as never;
}

describe("SessionManager error surfacing", () => {
  test("promptAsync throws when the engine refuses the prompt", async () => {
    const manager = new SessionManager(
      clientReturning({
        error: { code: "BadRequest", message: "no such model" },
      })
    );

    await expect(
      manager.promptAsync({ sessionID: "sess-1", text: "hello" })
    ).rejects.toThrow(PROMPT_FAILED);
  });

  test("promptAsync resolves when the engine accepts it", async () => {
    const manager = new SessionManager(clientReturning({ data: undefined }));

    await expect(
      manager.promptAsync({ sessionID: "sess-1", text: "hello" })
    ).resolves.toBeUndefined();
  });

  test("the failure names the engine's reason, not just that data was absent", async () => {
    // The old message was "returned no data", which reads like a parsing or
    // version problem and points at the wrong layer. It cost real diagnosis time
    // when an unreachable engine was reported that way.
    const manager = new SessionManager(
      clientReturning({
        error: {
          code: "ConnectionRefused",
          path: "http://127.0.0.1:4096/session",
        },
      })
    );

    await expect(
      manager.create({ directory: "/tmp/repo", title: "x" })
    ).rejects.toThrow(CONNECTION_REFUSED);
  });

  test("create throws on an error result", async () => {
    const manager = new SessionManager(
      clientReturning({ error: { code: "Nope" } })
    );
    await expect(manager.create({ title: "x" })).rejects.toThrow(CREATE_FAILED);
  });
});

describe("SessionManager session diff", () => {
  test("reads diff patches and file content from the requested checkout", async () => {
    const diff = mock(async () => ({
      data: [
        {
          additions: 1,
          deletions: 1,
          file: "src/main.ts",
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          status: "modified" as const,
        },
      ],
    }));
    const read = mock(async () => ({
      data: { content: "new\n", type: "text" as const },
    }));
    const manager = new SessionManager({
      session: { diff },
      file: { read },
    } as never);

    await expect(manager.diff("session-1", "/repo/worktree")).resolves.toEqual([
      {
        additions: 1,
        after: "new\n",
        before: "old\n",
        deletions: 1,
        file: "src/main.ts",
      },
    ]);
    expect(diff).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/repo/worktree",
    });
    expect(read).toHaveBeenCalledWith({
      path: "src/main.ts",
      directory: "/repo/worktree",
    });
  });
});
