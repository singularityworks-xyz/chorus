import type { Event as OCEvent, OpencodeClient } from "@opencode-ai/sdk/v2";

export type { Event as AgentEvent, SessionStatus } from "@opencode-ai/sdk/v2";

export type EventCallback = (event: OCEvent) => void;

export interface EventStreamHandle {
  stop: () => void;
}

interface DirSubscription {
  abort: AbortController;
  onStatus?: (status: EventStreamStatus) => void;
  recentEventIds: Set<string>;
  recentEventOrder: string[];
}

export type EventStreamStatus = "connected" | "exhausted" | "reconnecting";

export interface EventStreamOptions {
  directory?: string;
  onStatus?: (status: EventStreamStatus) => void;
}

interface ReconnectResult {
  attempts: number;
  stopped: boolean;
  stream: AsyncIterable<OCEvent> | null;
}

export class EventStream {
  readonly client: OpencodeClient;
  #running = false;
  readonly #dirSubscriptions = new Map<string, DirSubscription>();

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async subscribe(
    onEvent: EventCallback,
    options?: EventStreamOptions
  ): Promise<EventStreamHandle> {
    this.#running = true;

    const key = options?.directory ?? "__default__";

    if (this.#dirSubscriptions.has(key)) {
      return { stop: () => undefined };
    }

    const abort = new AbortController();
    const sub: DirSubscription = {
      abort,
      onStatus: options?.onStatus,
      recentEventIds: new Set(),
      recentEventOrder: [],
    };

    // Claim before awaiting so concurrent subscribers cannot open duplicate pumps.
    this.#dirSubscriptions.set(key, sub);

    let initial: Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>;
    try {
      initial = await this.client.event.subscribe({
        directory: options?.directory,
      });
    } catch (error) {
      this.#release(key, sub);
      throw error;
    }

    this.#pump(
      sub,
      key,
      initial.stream as AsyncIterable<OCEvent>,
      onEvent,
      abort,
      options?.directory
    );
    this.#notifyStatus(sub, "connected");

    return {
      stop: () => {
        abort.abort();
        this.#release(key, sub);
      },
    };
  }

  async #pump(
    sub: DirSubscription,
    key: string,
    firstStream: AsyncIterable<OCEvent>,
    onEvent: EventCallback,
    abort: AbortController,
    directory: string | undefined
  ): Promise<void> {
    let stream = firstStream;
    let attempts = 0;

    while (this.#running && !abort.signal.aborted) {
      const delivered = await this.#consumeSafely(sub, stream, onEvent, abort);
      if (!delivered.ok) {
        this.#release(key, sub);
        return;
      }

      attempts = delivered.count > 0 ? 0 : attempts + 1;
      this.#notifyStatus(sub, "reconnecting");
      const reopened = await this.#reopenWithRetry(directory, abort, attempts);
      attempts = reopened.attempts;
      if (!reopened.stream) {
        if (!reopened.stopped) {
          console.error("[oc-adapter] event stream reconnect exhausted:", key);
          this.#notifyStatus(sub, "exhausted");
        }
        this.#release(key, sub);
        return;
      }
      stream = reopened.stream;
      this.#notifyStatus(sub, "connected");
    }

    this.#release(key, sub);
  }

  async #consumeSafely(
    sub: DirSubscription,
    stream: AsyncIterable<OCEvent>,
    onEvent: EventCallback,
    abort: AbortController
  ): Promise<{ count: number; ok: boolean }> {
    try {
      return {
        count: await this.#consume(sub, stream, onEvent, abort),
        ok: true,
      };
    } catch (error) {
      if (!this.#running || abort.signal.aborted) {
        return { count: 0, ok: false };
      }
      console.error("[oc-adapter] event stream error:", error);
      return { count: 0, ok: true };
    }
  }

  async #reopenWithRetry(
    directory: string | undefined,
    abort: AbortController,
    initialAttempts: number
  ): Promise<ReconnectResult> {
    let attempts = initialAttempts;
    while (attempts <= MAX_STREAM_RECONNECTS) {
      await this.#backoff(Math.max(attempts, 1), abort);
      if (!this.#running || abort.signal.aborted) {
        return { attempts, stopped: true, stream: null };
      }

      const stream = await this.#reopen(directory, abort);
      if (stream) {
        return { attempts, stopped: false, stream };
      }
      if (!this.#running || abort.signal.aborted) {
        return { attempts, stopped: true, stream: null };
      }
      attempts += 1;
    }
    return { attempts, stopped: false, stream: null };
  }

  // Race each read with abort so a stalled iterator can be stopped.
  async #consume(
    sub: DirSubscription,
    stream: AsyncIterable<OCEvent>,
    onEvent: EventCallback,
    abort: AbortController
  ): Promise<number> {
    const iterator = stream[Symbol.asyncIterator]();
    let delivered = 0;

    try {
      for (;;) {
        if (!this.#running || abort.signal.aborted) {
          return delivered;
        }

        const next = await raceAbort(iterator.next(), abort.signal);
        if (next === ABORTED || next.done) {
          return delivered;
        }

        if (!this.#rememberEvent(sub, next.value)) {
          continue;
        }

        onEvent(next.value as OCEvent);
        delivered += 1;
      }
    } finally {
      await iterator.return?.(undefined).catch(() => undefined);
    }
  }

  #rememberEvent(sub: DirSubscription, value: unknown): boolean {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      value.id.length === 0
    ) {
      return true;
    }

    if (sub.recentEventIds.has(value.id)) {
      return false;
    }

    sub.recentEventIds.add(value.id);
    sub.recentEventOrder.push(value.id);
    if (sub.recentEventOrder.length > MAX_RECENT_EVENT_IDS) {
      const oldest = sub.recentEventOrder.shift();
      if (oldest) {
        sub.recentEventIds.delete(oldest);
      }
    }
    return true;
  }

  #notifyStatus(sub: DirSubscription, status: EventStreamStatus): void {
    try {
      sub.onStatus?.(status);
    } catch (error) {
      console.error("[oc-adapter] event stream status callback failed:", error);
    }
  }

  async #reopen(
    directory: string | undefined,
    abort: AbortController
  ): Promise<AsyncIterable<OCEvent> | null> {
    try {
      const reopened = await this.client.event.subscribe({ directory });
      return reopened.stream as AsyncIterable<OCEvent>;
    } catch (error) {
      if (!this.#running || abort.signal.aborted) {
        return null;
      }
      console.error("[oc-adapter] event resubscribe failed:", error);
      return null;
    }
  }

  // Remove only the current owner; stale pumps must not release a replacement.
  #release(key: string, sub: DirSubscription): void {
    if (this.#dirSubscriptions.get(key) !== sub) {
      return;
    }

    this.#dirSubscriptions.delete(key);
    if (this.#dirSubscriptions.size === 0) {
      this.#running = false;
    }
  }

  async #backoff(attempt: number, abort: AbortController): Promise<void> {
    const ceiling = Math.min(
      STREAM_RECONNECT_BASE_MS * 2 ** (attempt - 1),
      STREAM_RECONNECT_MAX_MS
    );
    const delayMs = Math.round(ceiling * Math.random());

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);

      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }

      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  stop() {
    this.#running = false;
    for (const sub of this.#dirSubscriptions.values()) {
      sub.abort.abort();
    }
    this.#dirSubscriptions.clear();
  }
}

const ABORTED = Symbol("aborted");

function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED);
  }

  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    let settled = false;
    const settle = (apply: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      apply();
    };

    const onAbort = (): void => settle(() => resolve(ABORTED));
    signal.addEventListener("abort", onAbort, { once: true });

    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        settle(() => resolve(value));
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);

        settle(() => reject(error));
      }
    );
  });
}

const STREAM_RECONNECT_BASE_MS = 250;
const STREAM_RECONNECT_MAX_MS = 10_000;

const MAX_STREAM_RECONNECTS = 10;

const MAX_RECENT_EVENT_IDS = 4096;
