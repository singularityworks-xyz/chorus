import { describe, expect, mock, test } from "bun:test";
import { SessionManager } from "./session-manager";

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

describe("SessionManager repository history", () => {
  test("revert checks and changes history in the requested checkout", async () => {
    const directory = "/repo/board-one";
    const userMessage = {
      info: { id: "user-1", role: "user" },
      parts: [],
    };
    const get = mock(async () => ({ data: { id: "session-1" } }));
    const messages = mock(async () => ({ data: [userMessage] }));
    const revert = mock(async () => ({ data: { id: "session-1" } }));
    const manager = new SessionManager({
      session: { get, messages, revert },
    } as never);

    await manager.revert({ sessionID: "session-1", directory });

    expect(get).toHaveBeenCalledWith({ sessionID: "session-1", directory });
    expect(messages).toHaveBeenCalledWith({
      sessionID: "session-1",
      limit: undefined,
      directory,
    });
    expect(revert).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory,
      workspace: undefined,
      messageID: "user-1",
    });
  });

  test("unrevert checks and changes history in the requested checkout", async () => {
    const directory = "/repo/board-one";
    const get = mock(async () => ({
      data: { id: "session-1", revert: { messageID: "user-1" } },
    }));
    const unrevert = mock(async () => ({ data: { id: "session-1" } }));
    const manager = new SessionManager({
      session: { get, unrevert },
    } as never);

    await manager.unrevert({ sessionID: "session-1", directory });

    expect(get).toHaveBeenCalledWith({ sessionID: "session-1", directory });
    expect(unrevert).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory,
      workspace: undefined,
    });
  });
});
