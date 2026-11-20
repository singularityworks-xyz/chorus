import type { PushApprovalPayload } from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { generateRequestDetails } from "web-push-neo";
import type { StoredPushSubscription } from "../workspace/database/types";
import type { PushConfiguration } from "./config";
import { waitForRetry, withDeliverySignal } from "./delivery-control";
import {
  assertSafePushEndpoint,
  pushSubscriptionInputSchema,
} from "./subscriptions";

const MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 5000;

export type PushFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface DeliveryJob {
  dedupeKey: string;
  deviceId: string;
  expiresAt: number;
  payload: PushApprovalPayload;
  subscription: StoredPushSubscription;
}

interface PushDeliveryTransportOptions {
  allowedHosts: string[];
  buildRequest: typeof generateRequestDetails;
  configuration: PushConfiguration;
  deletePushSubscription(
    subscription: StoredPushSubscription
  ): Promise<boolean>;
  fetcher: PushFetch;
  isConnected(deviceId: string): boolean;
  isCurrent(job: DeliveryJob): boolean;
  lookupHost?: (hostname: string) => Promise<Array<{ address: string }>>;
  markCompleted(job: DeliveryJob): Promise<void>;
  now(): number;
  random(): number;
  retryDelayMs: number;
  sendTimeoutMs?: number;
}

type SendAttemptResult =
  | { kind: "complete"; reason?: "expired" }
  | { errorName: string; kind: "retry" }
  | { host: string; kind: "retry"; retryAfterMs?: number; status: number };

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "PUSH"
);

export class PushDeliveryTransport {
  readonly #options: PushDeliveryTransportOptions;
  readonly #shutdown = new AbortController();
  readonly #controllers = new Set<AbortController>();
  #stopped = false;

  constructor(options: PushDeliveryTransportOptions) {
    this.#options = options;
  }

  stop(): void {
    this.#stopped = true;
    this.#shutdown.abort();
    for (const controller of this.#controllers) {
      controller.abort();
    }
    this.#controllers.clear();
  }

  async deliver(job: DeliveryJob): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (!this.#options.isCurrent(job)) {
        return false;
      }
      if (this.#options.isConnected(job.deviceId)) {
        return true;
      }

      const result = await this.#sendAttempt(job);
      if (result.kind === "complete") {
        if (!this.#options.isCurrent(job) && result.reason !== "expired") {
          return false;
        }
        await this.#options.markCompleted(job);
        return false;
      }
      if (attempt === MAX_ATTEMPTS) {
        this.#logExhaustedAttempt(result);
        await this.#options.markCompleted(job);
        return false;
      }

      const baseDelay = this.#options.retryDelayMs * 2 ** (attempt - 1);
      const jitteredDelay = Math.floor(
        baseDelay *
          (0.75 + Math.min(1, Math.max(0, this.#options.random())) * 0.5)
      );
      const retryAfter =
        "retryAfterMs" in result ? (result.retryAfterMs ?? 0) : 0;
      const retryDelay = Math.max(jitteredDelay, retryAfter);
      await waitForRetry(
        Math.min(retryDelay, Math.max(0, job.expiresAt - this.#options.now())),
        this.#shutdown.signal
      );
      if (this.#options.isConnected(job.deviceId)) {
        return true;
      }
    }
    return false;
  }

  async #sendAttempt(job: DeliveryJob): Promise<SendAttemptResult> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(
        this.#options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
        Math.max(0, job.expiresAt - this.#options.now())
      )
    );
    try {
      let endpoint: URL;
      try {
        endpoint = await withDeliverySignal(
          assertSafePushEndpoint(job.subscription.endpoint, {
            allowedHosts: this.#options.allowedHosts,
            ...(this.#options.lookupHost
              ? { lookupHost: this.#options.lookupHost }
              : {}),
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
        this.#options.buildRequest(
          subscription,
          JSON.stringify(job.payload),
          this.#requestOptions(job)
        ),
        controller.signal
      );
      controller.signal.throwIfAborted();
      if (!this.#options.isCurrent(job)) {
        return { kind: "complete" };
      }
      if (this.#options.isConnected(job.deviceId)) {
        return { errorName: "DeviceConnected", kind: "retry" };
      }

      const response = await withDeliverySignal(
        this.#options.fetcher(request.endpoint, {
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
      return { errorName: sendErrorName(error), kind: "retry" };
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(controller);
    }
  }

  #requestOptions(job: DeliveryJob) {
    return {
      TTL: Math.max(
        0,
        Math.floor((job.expiresAt - this.#options.now()) / 1000)
      ),
      urgency: "high" as const,
      vapidDetails: {
        privateKey: this.#options.configuration.privateKey ?? "",
        publicKey: this.#options.configuration.publicKey ?? "",
        subject: this.#options.configuration.subject ?? "",
      },
    };
  }

  async #handleResponse(
    response: Response,
    endpoint: URL,
    job: DeliveryJob
  ): Promise<SendAttemptResult> {
    if (response.status === 404 || response.status === 410) {
      await this.#options.deletePushSubscription(job.subscription);
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
      const retryAfter = retryAfterMs(response, this.#options.now());
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
    result: Exclude<SendAttemptResult, { kind: "complete" }>
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
}

function sendErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  return error.name === "AbortError" ? "TimeoutError" : error.name;
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
