import { createLogger } from "@chorus/logger";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "SERVE:WATCHDOG"
);

export const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

export interface WatchdogSessionInfo {
  boardId: string;
  directory: string;
}

export interface WatchdogCallbacks {
  onTimeout: (
    sessionId: string,
    info: WatchdogSessionInfo,
    message: string
  ) => void;
}

export class SessionWatchdog {
  readonly #bridge: OpenCodeBridge;
  readonly #callbacks: WatchdogCallbacks;
  readonly #timeoutMs: number;
  readonly #timers = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      info: WatchdogSessionInfo;
      startedAt: number;
    }
  >();

  constructor(
    bridge: OpenCodeBridge,
    callbacks: WatchdogCallbacks,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS
  ) {
    this.#bridge = bridge;
    this.#callbacks = callbacks;
    this.#timeoutMs = timeoutMs;
  }

  start(sessionId: string, info: WatchdogSessionInfo): void {
    this.#clear(sessionId);

    const timer = setTimeout(() => {
      this.#onTimeout(sessionId);
    }, this.#timeoutMs);

    this.#timers.set(sessionId, { timer, info, startedAt: Date.now() });

    logger.info("watchdog-started", {
      sessionId,
      boardId: info.boardId,
      timeoutMs: this.#timeoutMs,
    });
  }

  reset(sessionId: string): void {
    const existing = this.#timers.get(sessionId);
    if (!existing) {
      return;
    }

    clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.#onTimeout(sessionId);
    }, this.#timeoutMs);

    this.#timers.set(sessionId, {
      timer,
      info: existing.info,
      startedAt: existing.startedAt,
    });
  }

  stop(sessionId: string): void {
    const removed = this.#clear(sessionId);
    if (removed) {
      logger.info("watchdog-stopped", { sessionId });
    }
  }

  dispose(): void {
    for (const sessionId of this.#timers.keys()) {
      this.#clear(sessionId);
    }
    logger.info("watchdog-disposed", { remainingTimers: this.#timers.size });
  }

  getStatus(): { activeSessions: number; oldestSessionAgeMs: number } {
    let oldestAge = 0;
    for (const entry of this.#timers.values()) {
      const age = Date.now() - entry.startedAt;
      if (age > oldestAge) {
        oldestAge = age;
      }
    }
    return {
      activeSessions: this.#timers.size,
      oldestSessionAgeMs: oldestAge,
    };
  }

  #clear(sessionId: string): boolean {
    const entry = this.#timers.get(sessionId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.#timers.delete(sessionId);
    return true;
  }

  #onTimeout(sessionId: string): void {
    const entry = this.#timers.get(sessionId);
    if (!entry) {
      return;
    }

    this.#timers.delete(sessionId);

    const elapsedMs = Date.now() - entry.startedAt;
    const minutes = Math.floor(elapsedMs / 60_000);
    const seconds = Math.floor((elapsedMs % 60_000) / 1000);
    const message = `Session timed out after ${minutes}m ${seconds}s`;

    logger.warn("watchdog-timeout", {
      sessionId,
      boardId: entry.info.boardId,
      elapsedMs,
    });

    // The board's own directory, not the bridge default: a worktree board's
    // session does not exist in the directory serve was started in, so the abort
    // would fail to reach it.
    this.#bridge
      .abortSession(sessionId, entry.info.directory)
      .catch((error) => {
        logger.error(
          "watchdog-abort-failed",
          error instanceof Error ? error : undefined,
          { sessionId }
        );
      });

    this.#callbacks.onTimeout(sessionId, entry.info, message);
  }
}
