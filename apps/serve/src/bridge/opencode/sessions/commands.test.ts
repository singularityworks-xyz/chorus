import { describe, expect, mock, test } from "bun:test";
import type { OpenCodeAdapter, Session } from "@chorus/oc-adapter";
import { OpenCodeBridge } from "../bridge";

describe("OpenCodeBridge session commands", () => {
  test("pool commands resolve the engine for their checkout", async () => {
    const firstAdapter = {
      permissions: { reply: mock(async () => true) },
      sessions: {
        create: mock(async () => ({ id: "session-first" })),
      },
    } as unknown as OpenCodeAdapter;
    const secondAdapter = {
      sessions: {
        create: mock(async () => ({ id: "session-second" })),
      },
    } as unknown as OpenCodeAdapter;
    const engineProvider = {
      adapterForDirectory: mock(async (directory: string) =>
        directory === "/repo/first" ? firstAdapter : secondAdapter
      ),
      markReconciled: mock(() => undefined),
      markSessionActivity: mock(() => undefined),
      markSubscribed: mock(() => undefined),
      setEvictionHandler: mock(() => undefined),
    };
    const bridge = new OpenCodeBridge(
      "http://127.0.0.1:4096",
      "/repo",
      undefined,
      { engineProvider }
    );

    await bridge.start();
    await bridge.createSession({ directory: "/repo/first", title: "First" });
    await bridge.createSession({ directory: "/repo/second", title: "Second" });
    await bridge.replyPermission({
      directory: "/repo/first",
      requestID: "permission-1",
      reply: "once",
      sessionID: "session-first",
    });

    expect(firstAdapter.sessions.create).toHaveBeenCalledTimes(1);
    expect(secondAdapter.sessions.create).toHaveBeenCalledTimes(1);
    expect(firstAdapter.permissions.reply).toHaveBeenCalledTimes(1);
    expect(
      engineProvider.adapterForDirectory.mock.calls.map(
        ([directory]) => directory
      )
    ).toEqual(["/repo/first", "/repo/second", "/repo/first"]);
  });
  test("session reads pass the selected checkout into the SDK request", async () => {
    const session: Session = {
      directory: "/repo/board-one",
      id: "session-board",
      projectID: "fixture",
      slug: "session-board",
      time: { created: 1, updated: 1 },
      title: "Board one",
      version: "1.19.0",
    };
    const getSession = mock(async () => session);
    const adapter = {
      sessions: { get: getSession },
    } as unknown as OpenCodeAdapter;
    const engineProvider = {
      adapterForDirectory: mock(async () => adapter),
      markReconciled: mock(() => undefined),
      markSessionActivity: mock(() => undefined),
      markSubscribed: mock(() => undefined),
      setEvictionHandler: mock(() => undefined),
    };
    const bridge = new OpenCodeBridge(
      "http://127.0.0.1:4096",
      "/repo",
      undefined,
      { engineProvider }
    );

    await expect(
      bridge.getSession({
        engineDirectory: "/repo/board-one",
        sessionID: "session-board",
      })
    ).resolves.toBe(session);

    expect(getSession).toHaveBeenCalledWith("session-board", "/repo/board-one");
  });
});
