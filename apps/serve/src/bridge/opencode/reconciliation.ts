import { createLogger } from "@chorus/logger";
import type {
  EventStreamStatus,
  NormalizedAgentEvent,
  OpenCodeAdapter,
} from "@chorus/oc-adapter";

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5000;

interface ReconciliationOptions {
  activeSessionIds(directory: string): string[];
  adapterFor(directory: string): Promise<OpenCodeAdapter>;
  markReconciled(directory: string): void;
  onExhausted(directory: string): void;
  publish(directory: string, event: NormalizedAgentEvent): Promise<void>;
  recoverySessionIds(directory: string): string[];
}

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "BRIDGE"
);

export class EventStreamReconciler {
  readonly #options: ReconciliationOptions;
  readonly #states = new Map<string, EventStreamStatus>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #attempts = new Map<string, number>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: ReconciliationOptions) {
    this.#options = options;
  }

  get hasStatus(): boolean {
    return this.#states.size > 0;
  }

  get allConnected(): boolean {
    return [...this.#states.values()].every((status) => status === "connected");
  }

  onStatus(directory: string, status: EventStreamStatus): void {
    this.#states.set(directory, status);
    if (status === "connected") {
      this.#start(directory);
      return;
    }
    if (status === "exhausted") {
      this.#detach(directory);
      this.#options.onExhausted(directory);
      this.#failSessions(directory).catch((error: unknown) => {
        logger.error(
          "event-stream-exhaustion-state-failed",
          error instanceof Error ? error : undefined,
          { directory }
        );
      });
    }
  }

  removeDirectory(directory: string): void {
    this.#clearRetry(directory);
    this.#states.delete(directory);
  }

  stop(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#attempts.clear();
    this.#running.clear();
    this.#states.clear();
  }

  #start(directory: string): void {
    const timer = this.#timers.get(directory);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(directory);
    }
    if (this.#running.has(directory)) {
      return;
    }

    const reconciliation = this.#reconcile(directory).finally(() => {
      if (this.#running.get(directory) === reconciliation) {
        this.#running.delete(directory);
      }
    });
    this.#running.set(directory, reconciliation);
    reconciliation.catch((error: unknown) => {
      this.#scheduleRetry(directory, error);
    });
  }

  #scheduleRetry(directory: string, error: unknown): void {
    if (this.#states.get(directory) !== "connected") {
      return;
    }
    if (this.#timers.has(directory)) {
      return;
    }

    const attempts = (this.#attempts.get(directory) ?? 0) + 1;
    this.#attempts.set(directory, attempts);
    if (attempts > MAX_RETRIES) {
      logger.error(
        "event-stream-reconciliation-retries-exhausted",
        error instanceof Error ? error : undefined,
        { attempts, directory }
      );
      return;
    }

    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.#timers.delete(directory);
      if (this.#states.get(directory) === "connected") {
        this.#start(directory);
      }
    }, delay);
    this.#timers.set(directory, timer);
  }

  #detach(directory: string): void {
    const timer = this.#timers.get(directory);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(directory);
    }
    this.#attempts.delete(directory);
    this.#states.set(directory, "exhausted");
  }

  #clearRetry(directory: string): void {
    const timer = this.#timers.get(directory);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(directory);
    }
    this.#attempts.delete(directory);
  }

  async #failSessions(directory: string): Promise<void> {
    const sessionIds = new Set([
      ...this.#options.recoverySessionIds(directory),
      ...this.#options.activeSessionIds(directory),
    ]);
    const timestamp = Date.now();
    for (const sessionID of sessionIds) {
      await this.#options.publish(directory, {
        activity: "error",
        error: "The OpenCode event stream could not reconnect.",
        sessionID,
        sourceEventId: `stream-exhausted:${sessionID}`,
        timestamp,
        type: "session.error",
      });
    }
    this.#options.markReconciled(directory);
  }

  async #reconcile(directory: string): Promise<void> {
    try {
      const adapter = await this.#options.adapterFor(directory);
      const recoverySessions = this.#options.recoverySessionIds(directory);
      const recoverableSessionIds = new Set(recoverySessions);
      const [statuses, permissions, questions, histories] = await Promise.all([
        adapter.sessions.status(directory),
        adapter.permissions.list(directory),
        adapter.questions.list(directory),
        Promise.all(
          recoverySessions.map(async (sessionID) => {
            try {
              const messages = await adapter.sessions.messages(sessionID, {
                directory,
                limit: 200,
              });
              return adapter.normalizeHistory(sessionID, messages);
            } catch (error) {
              logger.warn("session-history-reconciliation-failed", {
                directory,
                errorName: error instanceof Error ? error.name : "unknown",
                sessionID,
              });
              throw error;
            }
          })
        ),
      ]);

      for (const history of histories) {
        for (const event of history) {
          await this.#options.publish(directory, event);
        }
      }

      const timestamp = Date.now();
      for (const [sessionID, status] of Object.entries(statuses)) {
        if (!recoverableSessionIds.has(sessionID)) {
          continue;
        }
        await this.#options.publish(directory, {
          activity: status.type === "idle" ? "idle" : "thinking",
          sessionID,
          timestamp,
          type: "session.status",
        });
      }

      for (const sessionID of recoverySessions) {
        if (Object.hasOwn(statuses, sessionID)) {
          continue;
        }
        await this.#options.publish(directory, {
          activity: "idle",
          sessionID,
          timestamp,
          type: "session.status",
        });
      }

      for (const permission of permissions) {
        if (!recoverableSessionIds.has(permission.sessionID)) {
          continue;
        }
        await this.#options.publish(directory, {
          activity: "waiting_for_approval",
          permissionID: permission.id,
          permission: permission.permission,
          sessionID: permission.sessionID,
          sourceEventId: `permission.asked:${permission.id}`,
          timestamp,
          type: "permission.asked",
        });
      }

      for (const question of questions) {
        if (!recoverableSessionIds.has(question.sessionID)) {
          continue;
        }
        await this.#options.publish(directory, {
          activity: "waiting_for_question",
          questionID: question.id,
          questions: question.questions,
          sessionID: question.sessionID,
          sourceEventId: `question.asked:${question.id}`,
          timestamp,
          type: "question.asked",
        });
      }
      this.#options.markReconciled(directory);
      this.#clearRetry(directory);
    } catch (error) {
      logger.error(
        "event-stream-reconciliation-failed",
        error instanceof Error ? error : undefined,
        { directory }
      );
      throw error;
    }
  }
}
