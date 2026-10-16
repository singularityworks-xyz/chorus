import { describe, expect, mock, test } from "bun:test";
import type {
  EventCallback,
  EventStreamHandle,
  EventStreamOptions,
  OpenCodeAdapter,
  SessionMessageWithParts,
} from "@chorus/oc-adapter";
import { OpenCodeBridge } from "./bridge";

describe("OpenCodeBridge", () => {
  test("creates bridge with valid config", () => {
    const bridge = new OpenCodeBridge("http://localhost:4096", "/tmp");

    expect(bridge).toBeDefined();
    expect(bridge.adapter).toBeDefined();
  });

  test("subscribe registers a callback and returns unsubscribe fn", () => {
    const bridge = new OpenCodeBridge("http://localhost:4096", "/tmp");
    const subscriber = mock(() => undefined);

    const unsubscribe = bridge.subscribe(subscriber);

    expect(typeof unsubscribe).toBe("function");

    unsubscribe();
  });

  test("getStatus returns connected false before start", () => {
    const bridge = new OpenCodeBridge("http://localhost:4096", "/tmp");

    const status = bridge.getStatus();

    expect(status.connected).toBe(false);
    expect(status.activeSessions).toBe(0);
    expect(status.opencodeUrl).toBe("http://localhost:4096");
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  test("forkSession is available on bridge", () => {
    const bridge = new OpenCodeBridge("http://localhost:4096", "/tmp");

    expect(typeof bridge.forkSession).toBe("function");
  });

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

  test("waits for recovered history and pending requests to persist before marking reconciled", async () => {
    const messages = [
      {
        info: {
          id: "message-1",
          role: "assistant",
          time: { created: 100 },
        },
        parts: [
          {
            id: "part-1",
            messageID: "message-1",
            sessionID: "session-1",
            text: "recovered output",
            type: "text",
          },
        ],
      },
    ] as unknown as SessionMessageWithParts[];
    let releasePersistence: () => void = () => undefined;
    let notifyPersistenceStarted: () => void = () => undefined;
    let markReconciled: () => void = () => undefined;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const persistenceStarted = new Promise<void>((resolve) => {
      notifyPersistenceStarted = resolve;
    });
    const reconciliationFinished = new Promise<void>((resolve) => {
      markReconciled = resolve;
    });
    const eventTypes: string[] = [];
    const adapter = {
      events: {
        subscribe: mock(
          (
            _callback: EventCallback,
            options?: EventStreamOptions
          ): Promise<EventStreamHandle> => {
            options?.onStatus?.("connected");
            return Promise.resolve({ stop: () => undefined });
          }
        ),
      },
      permissions: {
        list: mock(async () => [
          {
            id: "permission-1",
            permission: "edit",
            sessionID: "session-1",
          },
        ]),
      },
      questions: {
        list: mock(async () => [
          {
            id: "question-1",
            questions: [],
            sessionID: "session-1",
          },
        ]),
      },
      sessions: {
        messages: mock(async () => messages),
        status: mock(async () => ({ "session-1": { type: "busy" } })),
      },
    } as unknown as OpenCodeAdapter;
    const engineProvider = {
      adapterForDirectory: mock(async () => adapter),
      markReconciled: mock(() => markReconciled()),
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

    bridge.setRecoverySessionProvider(() => ["session-1"]);
    bridge.subscribe(async (event) => {
      eventTypes.push(event.type);
      if (event.type === "message.part.updated") {
        notifyPersistenceStarted();
        await persistenceGate;
      }
    });

    await bridge.subscribeDirectory("/repo/board-one");
    await persistenceStarted;
    expect(engineProvider.markReconciled).not.toHaveBeenCalled();

    releasePersistence();
    await reconciliationFinished;

    expect(eventTypes).toEqual([
      "message.part.updated",
      "session.status",
      "permission.asked",
      "question.asked",
    ]);
    expect(engineProvider.markReconciled).toHaveBeenCalledTimes(1);
    bridge.stop();
  });

  test("reconciliation ignores sessions that are not attached to recoverable board work", async () => {
    let finishReconciliation: () => void = () => undefined;
    const reconciliationFinished = new Promise<void>((resolve) => {
      finishReconciliation = resolve;
    });
    const received: string[] = [];
    const adapter = {
      events: {
        subscribe: mock(
          (
            _callback: EventCallback,
            options?: EventStreamOptions
          ): Promise<EventStreamHandle> => {
            options?.onStatus?.("connected");
            return Promise.resolve({ stop: () => undefined });
          }
        ),
      },
      permissions: {
        list: mock(async () => [
          {
            id: "permission-recovered",
            permission: "edit",
            sessionID: "session-recovered",
          },
          {
            id: "permission-new",
            permission: "edit",
            sessionID: "session-new",
          },
        ]),
      },
      questions: {
        list: mock(async () => [
          {
            id: "question-recovered",
            questions: [],
            sessionID: "session-recovered",
          },
          {
            id: "question-new",
            questions: [],
            sessionID: "session-new",
          },
        ]),
      },
      sessions: {
        messages: mock(async () => []),
        status: mock(
          async () =>
            ({
              "session-new": { type: "idle" },
              "session-recovered": { type: "busy" },
            }) as const
        ),
      },
    } as unknown as OpenCodeAdapter;
    const engineProvider = {
      adapterForDirectory: mock(async () => adapter),
      markReconciled: mock(() => finishReconciliation()),
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

    bridge.setRecoverySessionProvider(() => ["session-recovered"]);
    bridge.subscribe((event) => {
      received.push(`${event.type}:${event.sessionID ?? ""}`);
    });

    await bridge.subscribeDirectory("/repo/board-one");
    await reconciliationFinished;

    expect(received).toEqual([
      "session.status:session-recovered",
      "permission.asked:session-recovered",
      "question.asked:session-recovered",
    ]);
    bridge.stop();
  });

  test("persists terminal errors and releases a directory after stream exhaustion", async () => {
    let streamStatus: EventStreamOptions["onStatus"];
    let finishInitialReconciliation: () => void = () => undefined;
    let finishFailureHandling: () => void = () => undefined;
    const initialReconciliationComplete = new Promise<void>((resolve) => {
      finishInitialReconciliation = resolve;
    });
    const failureHandlingComplete = new Promise<void>((resolve) => {
      finishFailureHandling = resolve;
    });
    let reconciliationCount = 0;
    const adapter = {
      events: {
        subscribe: mock(
          (
            _callback: EventCallback,
            options?: EventStreamOptions
          ): Promise<EventStreamHandle> => {
            streamStatus = options?.onStatus;
            options?.onStatus?.("connected");
            return Promise.resolve({ stop: mock(() => undefined) });
          }
        ),
      },
      permissions: { list: mock(async () => []) },
      questions: { list: mock(async () => []) },
      sessions: {
        messages: mock(async () => []),
        status: mock(async () => ({ "session-1": { type: "busy" } })),
      },
    } as unknown as OpenCodeAdapter;
    const engineProvider = {
      adapterForDirectory: mock(async () => adapter),
      markReconciled: mock(() => {
        reconciliationCount += 1;
        if (reconciliationCount === 1) {
          finishInitialReconciliation();
        } else {
          finishFailureHandling();
        }
      }),
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
    const received: string[] = [];

    bridge.setRecoverySessionProvider(() => ["session-1"]);
    bridge.subscribe((event) => {
      received.push(event.type);
    });

    await bridge.subscribeDirectory("/repo/board-one");
    await initialReconciliationComplete;

    streamStatus?.("exhausted");
    await failureHandlingComplete;

    expect(received).toContain("session.error");
    expect(engineProvider.markReconciled).toHaveBeenCalledTimes(2);
    expect(engineProvider.markSubscribed).toHaveBeenLastCalledWith(
      "/repo/board-one",
      false
    );
    expect(bridge.getStatus().activeSessions).toBe(0);

    await bridge.subscribeDirectory("/repo/board-one");
    expect(adapter.events.subscribe).toHaveBeenCalledTimes(2);
    bridge.stop();
  });
});
