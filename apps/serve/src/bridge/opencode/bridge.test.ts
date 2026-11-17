import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EventCallback,
  EventStreamHandle,
  EventStreamOptions,
  NormalizedAgentEvent,
  OpenCodeAdapter,
  Session,
  SessionMessageWithParts,
} from "@chorus/oc-adapter";
import { normalizeSessionHistory } from "@chorus/oc-adapter";
import { WorkspaceStore } from "../../workspace/store";
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
      normalizeHistory: normalizeSessionHistory,
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

  test("rehydrated board recovers its active task, history, and pending requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "chorus-bridge-restart-"));
    const repository = join(root, "repository");
    const dataDirectory = join(root, "data");
    mkdirSync(repository, { recursive: true });
    let store: WorkspaceStore | undefined;
    let bridge: OpenCodeBridge | undefined;

    try {
      const firstStore = new WorkspaceStore(dataDirectory);
      store = firstStore;
      await firstStore.load();
      const created = await firstStore.applyMutation({
        baseRevision: null,
        clientId: "bridge-restart-test",
        mutationId: "create-restart-board",
        payload: {
          seed: {
            repo: {
              directory: repository,
              sandboxes: [],
              worktree: repository,
            },
            title: "Restart board",
          },
        },
        type: "board.create",
      });
      const createdEvent = created?.events[0];
      if (!created || createdEvent?.type !== "board.created") {
        throw new Error("expected the recovery fixture board to be created");
      }

      const boardId = createdEvent.board.boardId;
      await firstStore.applyMutation({
        baseRevision: null,
        clientId: "bridge-restart-test",
        mutationId: "attach-restart-session",
        payload: {
          boardId,
          session: { sessionId: "session-recovered", state: "active" },
        },
        type: "board.session.patch",
      });
      await firstStore.applyBoardEvents(boardId, [
        {
          boardId,
          column: "queue",
          task: {
            id: "task-recovered",
            label: "Recover task",
            labelVariant: "primary-light",
            title: "Recover task",
          },
          taskId: "task-recovered",
          ts: Date.now(),
          type: "card.created",
        },
      ]);
      await firstStore.close();

      // This is the same durable workspace file Serve opens during startup.
      const restartedStore = new WorkspaceStore(dataDirectory);
      store = restartedStore;
      await restartedStore.load();

      let markReconciled: () => void = () => undefined;
      const reconciliationFinished = new Promise<void>((resolve) => {
        markReconciled = resolve;
      });
      const history: SessionMessageWithParts[] = [
        {
          info: {
            id: "message-recovered",
            role: "assistant",
            time: { created: 100 },
          },
          parts: [
            {
              id: "part-recovered",
              messageID: "message-recovered",
              sessionID: "session-recovered",
              text: "recovered response text",
              type: "text",
            },
          ],
        },
      ] as unknown as SessionMessageWithParts[];
      const adapter = {
        normalizeHistory: normalizeSessionHistory,
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
          ]),
        },
        questions: {
          list: mock(async () => [
            {
              id: "question-recovered",
              questions: [],
              sessionID: "session-recovered",
            },
          ]),
        },
        sessions: {
          messages: mock(async () => history),
          status: mock(async () => ({ "session-recovered": { type: "busy" } })),
        },
      } as unknown as OpenCodeAdapter;
      const engineProvider = {
        adapterForDirectory: mock(async () => adapter),
        markReconciled: mock(() => markReconciled()),
        markSessionActivity: mock(() => undefined),
        markSubscribed: mock(() => undefined),
        setEvictionHandler: mock(() => undefined),
      };
      const restartedBridge = new OpenCodeBridge(
        "http://127.0.0.1:4096",
        repository,
        undefined,
        { engineProvider }
      );
      bridge = restartedBridge;
      restartedBridge.setRecoverySessionProvider(() => ["session-recovered"]);
      restartedBridge.subscribe(async (event: NormalizedAgentEvent) => {
        await restartedStore.applyAgentEvent(event);
      });

      await restartedBridge.subscribeDirectory(repository);
      await reconciliationFinished;

      const recoveredBoard = restartedStore.getBoard(boardId);
      const recoveredTask = recoveredBoard?.columns.approve.find(
        (task) => task.id === "task-recovered"
      );
      expect(recoveredBoard?.session).toMatchObject({
        currentTaskId: "task-recovered",
        sessionId: "session-recovered",
        state: "active",
      });
      expect(
        recoveredTask?.run?.steps.some((step) =>
          step.content?.includes("recovered response text")
        )
      ).toBe(true);
      expect(
        recoveredTask?.pendingApprovals?.map((request) => request.requestId)
      ).toEqual(["permission-recovered", "question-recovered"]);
      expect(
        restartedStore
          .eventsSince(0)
          .filter(
            ({ event }) =>
              event.type === "step.upserted" &&
              event.step.content?.includes("recovered response text") === true
          )
      ).toHaveLength(1);
      expect(engineProvider.markReconciled).toHaveBeenCalledTimes(1);
    } finally {
      bridge?.stop();
      await store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reconciliation ignores sessions that are not attached to recoverable board work", async () => {
    let finishReconciliation: () => void = () => undefined;
    const reconciliationFinished = new Promise<void>((resolve) => {
      finishReconciliation = resolve;
    });
    const received: string[] = [];
    const adapter = {
      normalizeHistory: normalizeSessionHistory,
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
      normalizeHistory: normalizeSessionHistory,
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
