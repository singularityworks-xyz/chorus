import {
  type PushApprovalPayload,
  pushApprovalPayloadSchema,
  type WorkspaceBoard,
  type WorkspaceEvent,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import { generateRequestDetails } from "web-push-neo";
import { z } from "zod";
import type { StoredPushSubscription } from "../workspace/db";
import type { StoreCommit } from "../workspace/store";
import type { PushConfiguration } from "./config";
import { waitForRetry, withDeliverySignal } from "./delivery-control";
import {
  assertSafePushEndpoint,
  pushSubscriptionInputSchema,
} from "./subscriptions";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "PUSH"
);

function sendErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  return error.name === "AbortError" ? "TimeoutError" : error.name;
}

const MAX_QUEUE = 256;
const MAX_CONCURRENCY = 4;
const DELIVERY_TTL_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 3;
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
  getBoard(boardId: string):
    | {
        boardId: string;
        columns: Record<
          string,
          Array<{
            id: string;
            label: string;
            pendingApproval?: {
              kind: "permission" | "question";
              requestId?: string;
            };
            pendingApprovals?: Array<{
              kind: "permission" | "question";
              requestId?: string;
            }>;
            title: string;
          }>
        >;
        title: string;
      }
    | undefined;
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

type PushFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface DeliveryJob {
  dedupeKey: string;
  deviceId: string;
  expiresAt: number;
  payload: PushApprovalPayload;
  subscription: StoredPushSubscription;
}

export interface PushDispatcherOptions {
  allowedHosts?: string[];
  buildRequest?: typeof generateRequestDetails;
  configuration: PushConfiguration;
  fetcher?: PushFetch;
  lookupHost?: (hostname: string) => Promise<Array<{ address: string }>>;
  now?: () => number;
  presence: DevicePresence;
  random?: () => number;
  retryDelayMs?: number;
  sendTimeoutMs?: number;
  store: PushStore;
}

/**
 * Best-effort push delivery. The store listener only assembles bounded jobs;
 * encryption and network I/O happen on this independent queue and can never
 * delay a workspace commit or an agent command.
 */
export class PushDispatcher {
  readonly #allowedHosts: string[];
  readonly #buildRequest: typeof generateRequestDetails;
  readonly #configuration: PushConfiguration;
  readonly #fetcher: PushFetch;
  readonly #lookupHost: PushDispatcherOptions["lookupHost"];
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #presence: DevicePresence;
  readonly #retryDelayMs: number;
  readonly #sendTimeoutMs: number;
  readonly #shutdown = new AbortController();
  readonly #store: PushStore;
  readonly #queue: DeliveryJob[] = [];
  readonly #seen = new Map<string, number>();
  readonly #completed = new Map<string, number>();
  readonly #controllers = new Set<AbortController>();
  #active = 0;
  #pumpTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #stopped = false;

  constructor(options: PushDispatcherOptions) {
    this.#allowedHosts = options.allowedHosts ?? [];
    this.#buildRequest = options.buildRequest ?? generateRequestDetails;
    this.#configuration = options.configuration;
    this.#fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.#lookupHost = options.lookupHost;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#presence = options.presence;
    this.#retryDelayMs = options.retryDelayMs ?? 350;
    this.#sendTimeoutMs = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
    this.#store = options.store;
  }

  start(): void {
    if (this.#unsubscribe || this.#stopped) {
      return;
    }
    this.#restoreCompleted();
    this.#unsubscribe = this.#store.onCommit((commit) => {
      // Keep the serialized store writer free of subscription scans and payload
      // work, especially during streamed token commits.
      queueMicrotask(() => this.#receiveCommit(commit));
    });
    queueMicrotask(() => {
      this.#reconcilePendingApprovals();
      this.#pump();
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#shutdown.abort();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#queue.length = 0;
    if (this.#pumpTimer) {
      clearTimeout(this.#pumpTimer);
      this.#pumpTimer = null;
    }
    for (const controller of this.#controllers) {
      controller.abort();
    }
    this.#controllers.clear();
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
      this.#deliver(job)
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

  async #deliver(job: DeliveryJob): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (!this.#isCurrent(job)) {
        return;
      }
      if (this.#presence.hasReadyConnectionForDevice(job.deviceId)) {
        this.#queue.push(job);
        return;
      }
      const result = await this.#sendAttempt(job);
      if (result.kind === "complete") {
        if (!this.#isCurrent(job) && result.reason !== "expired") {
          return;
        }
        await this.#markCompleted(job);
        return;
      }
      if (attempt === MAX_ATTEMPTS) {
        this.#logExhaustedAttempt(result);
        await this.#markCompleted(job);
        return;
      }
      const baseDelay = this.#retryDelayMs * 2 ** (attempt - 1);
      const jitteredDelay = Math.floor(
        baseDelay * (0.75 + Math.min(1, Math.max(0, this.#random())) * 0.5)
      );
      const retryAfter =
        "retryAfterMs" in result ? (result.retryAfterMs ?? 0) : 0;
      const retryDelay = Math.max(jitteredDelay, retryAfter);
      await waitForRetry(
        Math.min(retryDelay, Math.max(0, job.expiresAt - this.#now())),
        this.#shutdown.signal
      );
      if (this.#presence.hasReadyConnectionForDevice(job.deviceId)) {
        this.#queue.push(job);
        return;
      }
    }
  }

  #isCurrent(job: DeliveryJob): boolean {
    if (
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

  async #sendAttempt(
    job: DeliveryJob
  ): Promise<
    | { kind: "complete"; reason?: "expired" }
    | { errorName: string; kind: "retry" }
    | { host: string; kind: "retry"; retryAfterMs?: number; status: number }
  > {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.#sendTimeoutMs, Math.max(0, job.expiresAt - this.#now()))
    );
    try {
      let endpoint: URL;
      try {
        endpoint = await withDeliverySignal(
          assertSafePushEndpoint(job.subscription.endpoint, {
            allowedHosts: this.#allowedHosts,
            ...(this.#lookupHost ? { lookupHost: this.#lookupHost } : {}),
          }),
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) {
          throw error;
        }
        logger.warn("push-endpoint-rejected-at-send", {
          reason: "destination",
        });
        return { kind: "complete" };
      }
      const subscription = parseStoredSubscription(job.subscription, endpoint);
      if (!subscription) {
        logger.warn("push-subscription-rejected-at-send", { reason: "schema" });
        return { kind: "complete" };
      }
      const request = await withDeliverySignal(
        this.#buildRequest(
          subscription,
          JSON.stringify(job.payload),
          this.#requestOptions(job)
        ),
        controller.signal
      );
      controller.signal.throwIfAborted();
      if (!this.#isCurrent(job)) {
        return { kind: "complete" };
      }
      if (this.#presence.hasReadyConnectionForDevice(job.deviceId)) {
        return { errorName: "DeviceConnected", kind: "retry" };
      }
      const response = await withDeliverySignal(
        this.#fetcher(request.endpoint, {
          body: request.body,
          headers: request.headers,
          method: request.method,
          redirect: "manual",
          signal: controller.signal,
        }),
        controller.signal
      );
      try {
        return await this.#handleResponse(response, endpoint, job);
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (this.#stopped) {
        return { kind: "complete" };
      }
      return {
        errorName: sendErrorName(error),
        kind: "retry",
      };
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(controller);
    }
  }

  #requestOptions(job: DeliveryJob) {
    return {
      TTL: Math.max(0, Math.floor((job.expiresAt - this.#now()) / 1000)),
      urgency: "high" as const,
      vapidDetails: {
        privateKey: this.#configuration.privateKey ?? "",
        publicKey: this.#configuration.publicKey ?? "",
        subject: this.#configuration.subject ?? "",
      },
    };
  }

  async #handleResponse(
    response: Response,
    endpoint: URL,
    job: DeliveryJob
  ): Promise<
    | { kind: "complete"; reason?: "expired" }
    | { host: string; kind: "retry"; retryAfterMs?: number; status: number }
  > {
    if (response.status === 404 || response.status === 410) {
      await this.#store.deletePushSubscriptionIfMatches(job.subscription);
      logger.info("push-subscription-expired", { host: endpoint.hostname });
      return { kind: "complete", reason: "expired" };
    }
    if (response.ok) {
      logger.info("push-delivered", {
        host: endpoint.hostname,
        kind: job.payload.kind,
      });
      return { kind: "complete" };
    }
    if (response.status >= 500 || response.status === 429) {
      const retryAfter = retryAfterMs(response, this.#now());
      return {
        host: endpoint.hostname,
        kind: "retry",
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        status: response.status,
      };
    }
    logger.warn("push-provider-rejected", {
      host: endpoint.hostname,
      status: response.status,
    });
    return { kind: "complete" };
  }

  #logExhaustedAttempt(
    result:
      | { errorName: string; kind: "retry" }
      | { host: string; kind: "retry"; retryAfterMs?: number; status: number }
  ): void {
    if ("status" in result) {
      logger.warn("push-provider-transient-failure", {
        host: result.host,
        status: result.status,
      });
      return;
    }
    logger.warn("push-send-attempts-exhausted", {
      errorName: result.errorName,
    });
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
          // Legacy snapshots can contain a request lane without an identity.
          // Do not invent a dedupe key; a live engine reconciliation must first
          // recover the request ID from OpenCode.
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

function createApprovalPayload(
  event: Extract<WorkspaceEvent, { type: "card.waiting_for_approval" }>,
  boardTitle: string
): PushApprovalPayload | null {
  const requestId = event.requestId ?? event.pendingApproval?.requestId;
  const query = new URLSearchParams({
    board: event.boardId,
    card: event.taskId,
  }).toString();
  const parsed = pushApprovalPayloadSchema.safeParse({
    boardId: event.boardId,
    boardTitle: boardTitle.slice(0, 160),
    cardId: event.taskId,
    // Card titles originate from user prompts in the current composer. Keep
    // prompt text off external push providers and use a non-sensitive label.
    cardTitle:
      event.kind === "permission" ? "Permission request" : "Question request",
    kind: event.kind,
    ...(requestId ? { requestId } : {}),
    url: `/?${query}`,
    version: 1,
  });
  return parsed.success ? parsed.data : null;
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function parseStoredSubscription(
  subscription: StoredPushSubscription,
  endpoint: URL
) {
  try {
    const keys: unknown = JSON.parse(subscription.keys);
    const parsed = pushSubscriptionInputSchema.safeParse({
      endpoint: endpoint.href,
      expirationTime: subscription.expirationAt,
      keys,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
