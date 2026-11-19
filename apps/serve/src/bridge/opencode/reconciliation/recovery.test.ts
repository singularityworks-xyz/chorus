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
  SessionMessageWithParts,
} from "@chorus/oc-adapter";
import { normalizeSessionHistory } from "@chorus/oc-adapter";
import { WorkspaceStore } from "../../../workspace/store";
import { OpenCodeBridge } from "../bridge";

describe("OpenCodeBridge recovery", () => {
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
});
