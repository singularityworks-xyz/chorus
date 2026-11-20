import type {
  PushApprovalPayload,
  WorkspaceBoard,
  WorkspaceEvent,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import { generateRequestDetails } from "web-push-neo";
import { z } from "zod";
import type { StoredPushSubscription } from "../workspace/database/types";
import type { StoreCommit } from "../workspace/store";
import type { PushConfiguration } from "./config";
import {
  type DeliveryJob,
  PushDeliveryTransport,
  type PushFetch,
} from "./delivery-transport";
import { createApprovalPayload } from "./payload";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "PUSH"
);

const MAX_QUEUE = 256;
const MAX_CONCURRENCY = 4;
const DELIVERY_TTL_MS = 5 * 60_000;
const MAX_DEDUPE_KEYS = 2048;
const PRESENCE_POLL_MS = 1000;
const DELIVERY_LEDGER_KEY = "push:v1:delivery-ledger";

const deliveryLedgerSchema = z.object({
  entries: z
    .array(z.tuple([z.string().min(1), z.number().finite()]))
    .max(MAX_DEDUPE_KEYS),
  version: z.literal(1),
});

interface PushStore {
  deletePushSubscriptionIfMatches(
    subscription: StoredPushSubscription
  ): Promise<boolean>;
  getBoard(boardId: string): WorkspaceBoard | undefined;
  getMeta(key: string): string | null;
  getPushSubscription(endpoint: string): StoredPushSubscription | null;
  getSnapshot(): { boards: WorkspaceBoard[] };
  headSeq(): number;
  listPushSubscriptions(): StoredPushSubscription[];
  onCommit(listener: (commit: StoreCommit) => void): () => void;
  persistMetaChanges(
    changes: Array<{ key: string; value: string | null }>
  ): Promise<void>;
}

interface DevicePresence {
  hasReadyConnectionForDevice(deviceId: string): boolean;
}

export interface PushDispatcherOptions {
  allowedHosts?: string[];
  buildRequest?: typeof generateRequestDetails;
  configuration: PushConfiguration;
  fetcher?: PushFetch;
  isDeviceAllowed?: (deviceId: string) => boolean;
  lookupHost?: (hostname: string) => Promise<Array<{ address: string }>>;
  now?: () => number;
  presence: DevicePresence;
  random?: () => number;
  retryDelayMs?: number;
  sendTimeoutMs?: number;
  store: PushStore;
}

export class PushDispatcher {
  readonly #configuration: PushConfiguration;
  readonly #now: () => number;
  readonly #presence: DevicePresence;
  readonly #delivery: PushDeliveryTransport;
  readonly #store: PushStore;
  readonly #isDeviceAllowed: (deviceId: string) => boolean;
  readonly #queue: DeliveryJob[] = [];
  readonly #seen = new Map<string, number>();
  readonly #completed = new Map<string, number>();
  #active = 0;
  #pumpTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #stopped = false;

  constructor(options: PushDispatcherOptions) {
    this.#isDeviceAllowed = options.isDeviceAllowed ?? (() => true);
    this.#configuration = options.configuration;
    this.#now = options.now ?? Date.now;
    this.#presence = options.presence;
    this.#store = options.store;
    this.#delivery = new PushDeliveryTransport({
      allowedHosts: options.allowedHosts ?? [],
      buildRequest: options.buildRequest ?? generateRequestDetails,
      configuration: this.#configuration,
      deletePushSubscription: (subscription) =>
        this.#store.deletePushSubscriptionIfMatches(subscription),
      fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
      isConnected: (deviceId) =>
        this.#presence.hasReadyConnectionForDevice(deviceId),
      isCurrent: (job) => this.#isCurrent(job),
      lookupHost: options.lookupHost,
      markCompleted: (job) => this.#markCompleted(job),
      now: this.#now,
      random: options.random ?? Math.random,
      retryDelayMs: options.retryDelayMs ?? 350,
      sendTimeoutMs: options.sendTimeoutMs,
    });
  }

  start(): void {
    if (this.#unsubscribe || this.#stopped) {
      return;
    }
    this.#restoreCompleted();
    this.#unsubscribe = this.#store.onCommit((commit) => {
      queueMicrotask(() => this.#receiveCommit(commit));
    });
    queueMicrotask(() => {
      this.#reconcilePendingApprovals();
      this.#pump();
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#delivery.stop();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#queue.length = 0;
    if (this.#pumpTimer) {
      clearTimeout(this.#pumpTimer);
      this.#pumpTimer = null;
    }
  }

  #receiveCommit(commit: StoreCommit): void {
    if (this.#stopped || !this.#configuration.enabled) {
      return;
    }
    this.#pruneSeen();
    for (const event of commit.events) {
      this.#receiveApprovalEvent(event, commit.lastSeq);
    }
    this.#pump();
  }

  #receiveApprovalEvent(event: WorkspaceEvent, lastSeq: number): void {
    if (event.type !== "card.waiting_for_approval" || !event.pendingApproval) {
      return;
    }
    const board = this.#store.getBoard(event.boardId);
    if (!board) {
      return;
    }
    const task = Object.values(board.columns)
      .flat()
      .find((candidate) => candidate.id === event.taskId);
    if (!task) {
      return;
    }
    this.#queueApproval(event, board.title, lastSeq);
  }

  #queueApproval(
    event: Extract<WorkspaceEvent, { type: "card.waiting_for_approval" }>,
    boardTitle: string,
    lastSeq: number
  ): void {
    const payload = createApprovalPayload(event, boardTitle);
    if (!payload) {
      logger.warn("push-payload-rejected", { reason: "schema" });
      return;
    }
    for (const subscription of this.#store.listPushSubscriptions()) {
      this.#queueForDevice(subscription, payload, event, lastSeq);
    }
  }

  #queueForDevice(
    subscription: StoredPushSubscription,
    payload: PushApprovalPayload,
    event: Extract<WorkspaceEvent, { type: "card.waiting_for_approval" }>,
    lastSeq: number
  ): void {
    const deviceId = subscription.deviceId;
    if (!deviceId || subscription.keyId !== this.#configuration.keyId) {
      return;
    }
    const requestId = event.requestId ?? event.pendingApproval?.requestId;
    const identity = requestId ?? `${event.kind}:${lastSeq}`;
    const dedupeKey = `${event.boardId}:${event.taskId}:${identity}:${deviceId}:${subscription.keyId}`;
    if (this.#seen.has(dedupeKey)) {
      return;
    }
    if (this.#queue.length >= MAX_QUEUE) {
      logger.warn("push-queue-full", { droppedJobs: 1 });
      return;
    }
    this.#seen.set(dedupeKey, this.#now() + DELIVERY_TTL_MS);
    this.#queue.push({
      deviceId,
      expiresAt: this.#now() + DELIVERY_TTL_MS,
      payload,
      subscription,
      dedupeKey,
    });
  }

  #pruneSeen(): void {
    const now = this.#now();
    for (const [key, expiresAt] of this.#seen) {
      if (expiresAt <= now) {
        this.#seen.delete(key);
      }
    }
    while (this.#seen.size > MAX_DEDUPE_KEYS) {
      const oldest = this.#seen.keys().next().value;
      if (!oldest) {
        return;
      }
      this.#seen.delete(oldest);
    }
    for (const [key, expiresAt] of this.#completed) {
      if (expiresAt <= now) {
        this.#completed.delete(key);
      }
    }
    while (this.#completed.size > MAX_DEDUPE_KEYS) {
      const oldest = this.#completed.keys().next().value;
      if (!oldest) {
        return;
      }
      this.#completed.delete(oldest);
    }
  }

  #pump(): void {
    if (this.#pumpTimer) {
      clearTimeout(this.#pumpTimer);
      this.#pumpTimer = null;
    }
    let remaining = this.#queue.length;
    while (
      !this.#stopped &&
      this.#active < MAX_CONCURRENCY &&
      this.#queue.length > 0 &&
      remaining > 0
    ) {
      remaining -= 1;
      const job = this.#queue.shift();
      if (!job) {
        return;
      }
      if (!this.#isCurrent(job)) {
        this.#seen.delete(job.dedupeKey);
        continue;
      }
      if (this.#presence.hasReadyConnectionForDevice(job.deviceId)) {
        this.#queue.push(job);
        continue;
      }
      this.#active += 1;
      this.#delivery
        .deliver(job)
        .then((shouldRequeue) => {
          if (shouldRequeue && !this.#stopped) {
            this.#queue.push(job);
          }
        })
        .catch((error: unknown) => {
          logger.warn("push-delivery-failed", {
            errorName: error instanceof Error ? error.name : "unknown",
          });
        })
        .finally(() => {
          this.#active -= 1;
          this.#pump();
        });
    }
    if (
      !this.#stopped &&
      this.#queue.length > 0 &&
      this.#active < MAX_CONCURRENCY
    ) {
      this.#pumpTimer = setTimeout(() => {
        this.#pumpTimer = null;
        this.#pump();
      }, PRESENCE_POLL_MS);
      this.#pumpTimer.unref?.();
    }
  }

  #isCurrent(job: DeliveryJob): boolean {
    if (
      !this.#isDeviceAllowed(job.deviceId) ||
      this.#stopped ||
      this.#now() >= job.expiresAt ||
      !this.#isPending(job)
    ) {
      return false;
    }
    return sameSubscription(
      this.#store.getPushSubscription(job.subscription.endpoint),
      job.subscription
    );
  }

  #isPending(job: DeliveryJob): boolean {
    const board = this.#store.getBoard(job.payload.boardId);
    const task =
      board &&
      Object.values(board.columns)
        .flat()
        .find((entry) => entry.id === job.payload.cardId);
    if (!task) {
      return false;
    }
    const pending =
      task.pendingApprovals ??
      (task.pendingApproval ? [task.pendingApproval] : []);
    return pending.some((entry) =>
      job.payload.requestId
        ? entry.requestId === job.payload.requestId
        : entry.kind === job.payload.kind
    );
  }

  #reconcilePendingApprovals(): void {
    if (this.#stopped || !this.#configuration.enabled) {
      return;
    }
    const lastSeq = this.#store.headSeq();
    for (const board of this.#store.getSnapshot().boards) {
      for (const task of Object.values(board.columns).flat()) {
        const requests =
          task.pendingApprovals ??
          (task.pendingApproval ? [task.pendingApproval] : []);
        for (const request of requests) {
          if (!request.requestId) {
            continue;
          }
          const event: Extract<
            WorkspaceEvent,
            { type: "card.waiting_for_approval" }
          > = {
            boardId: board.boardId,
            kind: request.kind,
            pendingApproval: request,
            requestId: request.requestId,
            taskId: task.id,
            ts: this.#now(),
            type: "card.waiting_for_approval",
          };
          this.#queueApproval(event, board.title, lastSeq);
        }
      }
    }
  }

  #restoreCompleted(): void {
    const raw = this.#store.getMeta(DELIVERY_LEDGER_KEY);
    if (!raw) {
      return;
    }
    try {
      const parsed = deliveryLedgerSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error("invalid delivery ledger schema");
      }
      const now = this.#now();
      for (const [key, expiresAt] of parsed.data.entries) {
        if (expiresAt > now) {
          this.#completed.set(key, expiresAt);
          this.#seen.set(key, expiresAt);
        }
      }
      this.#pruneSeen();
    } catch {
      logger.warn("push-delivery-ledger-invalid", { version: 1 });
    }
  }

  async #markCompleted(job: DeliveryJob): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#completed.set(job.dedupeKey, job.expiresAt);
    this.#pruneSeen();
    try {
      await this.#store.persistMetaChanges([
        {
          key: DELIVERY_LEDGER_KEY,
          value: JSON.stringify({
            entries: [...this.#completed],
            version: 1,
          }),
        },
      ]);
    } catch (error) {
      logger.warn("push-delivery-ledger-write-failed", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

function sameSubscription(
  current: StoredPushSubscription | null,
  queued: StoredPushSubscription
): boolean {
  return Boolean(
    current &&
      current.deviceId === queued.deviceId &&
      current.keyId === queued.keyId &&
      current.keys === queued.keys &&
      current.updatedAt === queued.updatedAt
  );
}
