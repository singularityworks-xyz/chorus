import { describe, expect, mock, test } from "bun:test";
import type { WorkspaceBoard, WorkspaceEvent } from "@chorus/contracts";
import type {
  PushSubscription,
  RequestDetails,
  SendNotificationOptions,
} from "web-push-neo";
import type { StoredPushSubscription } from "../workspace/db";
import type { StoreCommit } from "../workspace/store";
import type { PushConfiguration } from "./config";
import { PushDispatcher, type PushDispatcherOptions } from "./dispatcher";

const configuration: PushConfiguration = {
  enabled: true,
  keyId: "0123456789abcdef01234567",
  privateKey: "private-key",
  publicKey: "public-key",
  subject: "mailto:ops@example.com",
};

const subscription: StoredPushSubscription = {
  createdAt: 1,
  deviceId: "device-phone",
  endpoint: "https://fcm.googleapis.com/push/send/subscription-id",
  expirationAt: null,
  keyId: configuration.keyId,
  keys: JSON.stringify({
    auth: "AAAAAAAAAAAAAAAAAAAAAA",
    p256dh: "A".repeat(87),
  }),
  updatedAt: 1,
};

function createHarness({
  initialMeta,
  onFetch,
  online = false,
  status = 201,
  pending = true,
  overrides = {},
}: {
  initialMeta?: Map<string, string>;
  onFetch?: () => void;
  online?: boolean;
  pending?: boolean;
  status?: number;
  overrides?: Partial<PushDispatcherOptions>;
} = {}) {
  const listeners = new Set<(commit: StoreCommit) => void>();
  const deleted = mock(async (_subscription: StoredPushSubscription) => true);
  const metadata = initialMeta ?? new Map<string, string>();
  let currentSubscription = subscription;
  const fetcher = mock(
    (_input: string | URL | Request, _init?: RequestInit) => {
      onFetch?.();
      return Promise.resolve(new Response(null, { status }));
    }
  );
  const task = {
    id: "task-1",
    label: "Review",
    labelVariant: "warning-light" as const,
    pendingApproval: pending
      ? { kind: "permission" as const, requestId: "request-1" }
      : undefined,
    pendingApprovals: pending
      ? [{ kind: "permission" as const, requestId: "request-1" }]
      : [],
    title: "Change the service",
  };
  const board = {
    boardId: "board-1",
    columns: { approve: [task], done: [], in_progress: [], queue: [] },
    modelSelection: null,
    position: { x: 0, y: 0 },
    repo: { directory: "/repo", sandboxes: [], worktree: "/repo" },
    reviewMode: "auto" as const,
    session: { state: "active" as const },
    title: "Core service",
  } satisfies WorkspaceBoard;
  const store = {
    deletePushSubscriptionIfMatches: deleted,
    getBoard: mock(() => board),
    getMeta: mock((key: string) => metadata.get(key) ?? null),
    getPushSubscription: mock((_endpoint: string) => currentSubscription),
    getSnapshot: mock(() => ({ boards: [board] })),
    headSeq: mock(() => 0),
    listPushSubscriptions: mock(() => [subscription]),
    persistMetaChanges: mock(
      (changes: Array<{ key: string; value: string | null }>) =>
        Promise.resolve().then(() => {
          for (const change of changes) {
            if (change.value === null) {
              metadata.delete(change.key);
            } else {
              metadata.set(change.key, change.value);
            }
          }
        })
    ),
    onCommit: mock((listener: (commit: StoreCommit) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const presence = { hasReadyConnectionForDevice: mock(() => online) };
  const buildRequest = mock(
    async (
      input: PushSubscription,
      _payload?: string | Uint8Array<ArrayBuffer> | null,
      _options?: SendNotificationOptions
    ): Promise<RequestDetails> => ({
      body: new Uint8Array(new ArrayBuffer(4)),
      endpoint: input.endpoint,
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
    })
  );
  const dispatcher = new PushDispatcher({
    buildRequest,
    configuration,
    fetcher,
    lookupHost: async () => [{ address: "142.250.72.196" }],
    presence,
    retryDelayMs: 0,
    store,
    ...overrides,
  });
  dispatcher.start();
  return {
    buildRequest,
    deleted,
    dispatcher,
    fetcher,
    listeners,
    presence,
    store,
    task,
    setCurrentSubscription: (next: StoredPushSubscription) => {
      currentSubscription = next;
    },
    metadata,
  };
}

function makeCommit(event: WorkspaceEvent): StoreCommit {
  return {
    boardId: "board-1",
    events: [event],
    firstSeq: 10,
    lastSeq: 10,
  };
}

function waitingEvent(): WorkspaceEvent {
  return {
    boardId: "board-1",
    kind: "permission",
    pendingApproval: {
      kind: "permission",
      permission: "write",
      requestId: "request-1",
    },
    requestId: "request-1",
    taskId: "task-1",
    ts: 10,
    type: "card.waiting_for_approval",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("PushDispatcher", () => {
  test("retries transient provider failures only within the attempt budget", async () => {
    for (const status of [429, 500]) {
      const harness = createHarness({ status });
      try {
        await waitFor(
          () => harness.store.persistMetaChanges.mock.calls.length === 1
        );
        expect(harness.fetcher).toHaveBeenCalledTimes(3);
      } finally {
        harness.dispatcher.stop();
      }
    }
  });

  test("a hanging DNS lookup times out without holding the queue indefinitely", async () => {
    const lookupHost = mock(
      () => new Promise<Array<{ address: string }>>(() => undefined)
    );
    const harness = createHarness({
      overrides: { lookupHost, sendTimeoutMs: 5 },
    });
    try {
      await waitFor(
        () => harness.store.persistMetaChanges.mock.calls.length === 1
      );
      expect(lookupHost).toHaveBeenCalledTimes(3);
      expect(harness.fetcher).not.toHaveBeenCalled();
      expect(harness.store.persistMetaChanges).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispatcher.stop();
    }
  });

  test("shutdown cancels a provider Retry-After without another attempt", async () => {
    const fetcher = mock(
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "120" } })
    );
    const harness = createHarness({ overrides: { fetcher } });
    await waitFor(() => fetcher.mock.calls.length === 1);
    harness.dispatcher.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(harness.store.persistMetaChanges).not.toHaveBeenCalled();
  });

  test("shutdown aborts a send that is awaiting its transport", async () => {
    let sendSignal: AbortSignal | undefined;
    const fetcher: NonNullable<PushDispatcherOptions["fetcher"]> = (
      _input,
      init
    ) => {
      sendSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };
    const harness = createHarness({ overrides: { fetcher } });
    await waitFor(() => sendSignal !== undefined);
    harness.dispatcher.stop();
    expect(sendSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.store.persistMetaChanges).not.toHaveBeenCalled();
  });

  test("delivers a pending request through a safe no-redirect transport", async () => {
    const harness = createHarness();
    const { dispatcher, fetcher, listeners } = harness;
    const [listener] = [...listeners];
    listener?.(makeCommit(waitingEvent()));

    await waitFor(() => fetcher.mock.calls.length === 1);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(harness.presence.hasReadyConnectionForDevice).toHaveBeenCalledWith(
      "device-phone"
    );
    const payload = JSON.parse(
      String(harness.buildRequest.mock.calls[0]?.[1])
    ) as { cardTitle: string };
    expect(payload.cardTitle).toBe("Permission request");
    expect(payload.cardTitle).not.toContain("Change the service");
    expect(harness.store.persistMetaChanges).toHaveBeenCalledTimes(1);
    dispatcher.stop();
  });

  test("suppresses delivery only when the destination device is connected", async () => {
    const harness = createHarness({ online: true });
    const [listener] = [...harness.listeners];
    listener?.(makeCommit(waitingEvent()));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.fetcher).not.toHaveBeenCalled();
    harness.dispatcher.stop();
  });

  test("rechecks durable request state before sending", async () => {
    const harness = createHarness({ pending: false });
    const [listener] = [...harness.listeners];
    listener?.(makeCommit(waitingEvent()));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.fetcher).not.toHaveBeenCalled();
    harness.dispatcher.stop();
  });

  test("removes only an expired endpoint owned by the destination device", async () => {
    const harness = createHarness({ status: 410 });
    const [listener] = [...harness.listeners];
    listener?.(makeCommit(waitingEvent()));
    await waitFor(() => harness.deleted.mock.calls.length === 1);

    expect(harness.deleted.mock.calls[0]?.[0]).toEqual(subscription);
    harness.dispatcher.stop();
  });

  test("a late provider 410 cannot delete a replacement subscription", async () => {
    const replacement = {
      ...subscription,
      keys: JSON.stringify({ auth: "replacement", p256dh: "replacement" }),
      updatedAt: 2,
    };
    const harness = createHarness({
      onFetch: () => harness.setCurrentSubscription(replacement),
      status: 410,
    });
    const [listener] = [...harness.listeners];
    listener?.(makeCommit(waitingEvent()));
    await waitFor(() => harness.fetcher.mock.calls.length === 1);

    expect(harness.deleted).toHaveBeenCalledWith(subscription);
    expect(harness.store.getPushSubscription(subscription.endpoint)).toBe(
      replacement
    );
    harness.dispatcher.stop();
  });

  test("reconciles unresolved approvals after a server restart", async () => {
    const harness = createHarness();
    await waitFor(() => harness.fetcher.mock.calls.length === 1);
    expect(harness.buildRequest.mock.calls[0]?.[1]).toEqual(
      expect.stringContaining('"requestId":"request-1"')
    );
    harness.dispatcher.stop();

    const restarted = createHarness({ initialMeta: harness.metadata });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(restarted.fetcher).not.toHaveBeenCalled();
    restarted.dispatcher.stop();
  });

  test("does not deliver the same durable request twice", async () => {
    const harness = createHarness();
    const [listener] = [...harness.listeners];
    listener?.(makeCommit(waitingEvent()));
    listener?.(makeCommit(waitingEvent()));
    await waitFor(() => harness.fetcher.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.fetcher).toHaveBeenCalledTimes(1);
    harness.dispatcher.stop();
  });
});
