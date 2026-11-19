import { describe, expect, mock, test } from "bun:test";
import type {
  EventCallback,
  EventStreamHandle,
  EventStreamOptions,
  OpenCodeAdapter,
} from "@chorus/oc-adapter";
import { normalizeSessionHistory } from "@chorus/oc-adapter";
import { OpenCodeBridge } from "../bridge";

describe("OpenCodeBridge stream lifecycle", () => {
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
