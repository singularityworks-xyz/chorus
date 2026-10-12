import { createLogger } from "@chorus/logger";
import type {
  EventStreamHandle,
  EventStreamStatus,
  NormalizedAgentEvent,
  PermissionHandlerInput,
  QuestionReplyInput,
  QuestionRequest,
  SessionCreateInput,
  SessionForkInput,
  SessionPromptInput,
} from "@chorus/oc-adapter";
import { normalizeSessionHistory, OpenCodeAdapter } from "@chorus/oc-adapter";
import { EngineUnavailableError } from "../../opencode/process-manager";

const MAX_RECONCILIATION_RETRIES = 5;
const RECONCILIATION_RETRY_BASE_MS = 250;
const RECONCILIATION_RETRY_MAX_MS = 5000;

export interface DirectoryEngineProvider {
  adapterForDirectory(directory: string): Promise<OpenCodeAdapter>;
  markReconciled(directory: string): void;
  markSessionActivity(
    directory: string,
    sessionId: string,
    active: boolean
  ): void;
  markSubscribed(directory: string, subscribed: boolean): void;
  setEvictionHandler(handler: (directory: string) => void): void;
}

export type EventSubscriber = (
  event: NormalizedAgentEvent
) => void | Promise<void>;

export interface BridgeStatus {
  activeSessions: number;
  connected: boolean;
  opencodeUrl: string;
  subscribedDirectories: string[];
  uptime: number;
}

export class OpenCodeBridge {
  readonly adapter: OpenCodeAdapter;
  readonly #baseUrl: string;
  readonly #defaultDirectory: string;
  readonly #ensureEngineReady: () => Promise<void>;
  readonly #engineProvider: DirectoryEngineProvider | undefined;
  #eventHandle: EventStreamHandle | null = null;
  readonly #directoryHandles = new Map<string, EventStreamHandle>();
  readonly #streamStates = new Map<string, EventStreamStatus>();
  readonly #subscribers = new Set<EventSubscriber>();
  readonly #activeSessions = new Map<
    string,
    { activity: string; directory: string; sessionID: string }
  >();
  readonly #reconciliations = new Map<string, Promise<void>>();
  readonly #reconciliationRetryAttempts = new Map<string, number>();
  readonly #reconciliationRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  #recoverySessions: (directory: string) => string[] = () => [];
  readonly #startTime = Date.now();
  readonly #logger = createLogger(
    {
      env: process.env.NODE_ENV === "production" ? "production" : "development",
    },
    "BRIDGE"
  );

  constructor(
    baseUrl: string,
    directory: string,
    auth?: { password: string; username: string },
    options: {
      ensureEngineReady?: () => Promise<void>;
      engineProvider?: DirectoryEngineProvider;
    } = {}
  ) {
    this.#baseUrl = baseUrl;
    this.#defaultDirectory = directory;
    this.#ensureEngineReady =
      options.ensureEngineReady ?? (() => Promise.resolve());
    this.#engineProvider = options.engineProvider;
    this.#engineProvider?.setEvictionHandler((evictedDirectory) => {
      this.#removeDirectorySubscription(evictedDirectory);
    });
    this.adapter = OpenCodeAdapter.from({
      auth,
      baseUrl,
      directory,
    });
    this.#startTime = Date.now();
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  setRecoverySessionProvider(provider: (directory: string) => string[]): void {
    this.#recoverySessions = provider;
  }

  async start(): Promise<void> {
    // Pool engines are started lazily for a board's canonical checkout. There
    // is no default shared stream in that mode.
    if (this.#engineProvider) {
      return;
    }
    if (this.#eventHandle !== null) {
      return;
    }

    const adapter = await this.#adapterFor(this.#defaultDirectory);
    const handle = await adapter.events.subscribe(
      (event) => {
        const normalized = adapter.normalize(event);
        this.#trackSession(normalized, this.#defaultDirectory);
        this.#broadcast(normalized);
      },
      {
        onStatus: (status) =>
          this.#onStreamStatus(this.#defaultDirectory, status),
      }
    );

    this.#eventHandle = handle;
    this.#logger.info("event-subscription-started", {
      directory: this.#defaultDirectory,
    });
  }

  async subscribeDirectory(directory: string): Promise<void> {
    if (
      !this.#engineProvider &&
      directory === this.#defaultDirectory &&
      this.#eventHandle !== null
    ) {
      return;
    }
    if (this.#directoryHandles.has(directory)) {
      return;
    }

    this.#logger.info("subscribing-to-directory", { directory });

    const adapter = await this.#adapterFor(directory);
    let handle: EventStreamHandle;
    try {
      handle = await adapter.events.subscribe(
        (event) => {
          const normalized = adapter.normalize(event);
          this.#trackSession(normalized, directory);
          this.#broadcast(normalized);
        },
        {
          directory,
          onStatus: (status) => this.#onStreamStatus(directory, status),
        }
      );
    } catch (error) {
      this.#engineProvider?.markSubscribed(directory, false);
      throw error;
    }

    this.#directoryHandles.set(directory, handle);
    this.#engineProvider?.markSubscribed(directory, true);
    this.#logger.info("directory-subscribed", { directory });
  }

  #trackSession(event: NormalizedAgentEvent, directory: string): void {
    if (!event.sessionID) {
      return;
    }

    const activity = event.activity ?? event.type;

    const key = `${directory}\0${event.sessionID}`;
    if (activity === "idle" || activity === "error") {
      this.#activeSessions.delete(key);
    } else {
      this.#activeSessions.set(key, {
        activity,
        directory,
        sessionID: event.sessionID,
      });
    }
    this.#engineProvider?.markSessionActivity(
      directory,
      event.sessionID,
      activity !== "idle" && activity !== "error"
    );
  }

  #broadcast(event: NormalizedAgentEvent): void {
    for (const subscriber of this.#subscribers) {
      try {
        const result = subscriber(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            this.#logger.error(
              "event-subscriber-failed",
              error instanceof Error ? error : undefined,
              {
                eventType: event.type,
                ...(event.sessionID && { sessionID: event.sessionID }),
              }
            );
          });
        }
      } catch (error) {
        this.#logger.error(
          "event-subscriber-failed",
          error instanceof Error ? error : undefined,
          {
            eventType: event.type,
            ...(event.sessionID && { sessionID: event.sessionID }),
          }
        );
      }
    }
  }

  async #broadcastAndWait(event: NormalizedAgentEvent): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#subscribers].map(async (subscriber) => subscriber(event))
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      for (const failure of failures) {
        if (failure.status === "rejected") {
          this.#logger.error(
            "event-reconciliation-subscriber-failed",
            failure.reason instanceof Error ? failure.reason : undefined,
            {
              eventType: event.type,
              ...(event.sessionID && { sessionID: event.sessionID }),
            }
          );
        }
      }
      throw new Error(
        `Failed to persist reconciled ${event.type} event for every subscriber`
      );
    }
  }

  #onStreamStatus(directory: string, status: EventStreamStatus): void {
    this.#streamStates.set(directory, status);
    if (status === "connected") {
      this.#startReconciliation(directory);
      return;
    }
    if (status === "exhausted") {
      this.#detachExhaustedStream(directory);
      this.#failDirectorySessions(directory).catch((error: unknown) => {
        this.#logger.error(
          "event-stream-exhaustion-state-failed",
          error instanceof Error ? error : undefined,
          { directory }
        );
      });
    }
  }

  #startReconciliation(directory: string): void {
    const timer = this.#reconciliationRetryTimers.get(directory);
    if (timer) {
      clearTimeout(timer);
      this.#reconciliationRetryTimers.delete(directory);
    }
    if (this.#reconciliations.has(directory)) {
      return;
    }

    const reconciliation = this.#reconcileDirectory(directory).finally(() => {
      if (this.#reconciliations.get(directory) === reconciliation) {
        this.#reconciliations.delete(directory);
      }
    });
    this.#reconciliations.set(directory, reconciliation);
    reconciliation.catch((error: unknown) => {
      this.#scheduleReconciliationRetry(directory, error);
    });
  }

  #scheduleReconciliationRetry(directory: string, error: unknown): void {
    if (this.#streamStates.get(directory) !== "connected") {
      return;
    }
    if (this.#reconciliationRetryTimers.has(directory)) {
      return;
    }

    const attempts =
      (this.#reconciliationRetryAttempts.get(directory) ?? 0) + 1;
    this.#reconciliationRetryAttempts.set(directory, attempts);
    if (attempts > MAX_RECONCILIATION_RETRIES) {
      this.#logger.error(
        "event-stream-reconciliation-retries-exhausted",
        error instanceof Error ? error : undefined,
        { attempts, directory }
      );
      return;
    }

    const delay = Math.min(
      RECONCILIATION_RETRY_BASE_MS * 2 ** (attempts - 1),
      RECONCILIATION_RETRY_MAX_MS
    );
    const timer = setTimeout(() => {
      this.#reconciliationRetryTimers.delete(directory);
      if (this.#streamStates.get(directory) === "connected") {
        this.#startReconciliation(directory);
      }
    }, delay);
    this.#reconciliationRetryTimers.set(directory, timer);
  }

  #clearReconciliationRetry(directory: string): void {
    const timer = this.#reconciliationRetryTimers.get(directory);
    if (timer) {
      clearTimeout(timer);
      this.#reconciliationRetryTimers.delete(directory);
    }
    this.#reconciliationRetryAttempts.delete(directory);
  }

  #detachExhaustedStream(directory: string): void {
    this.#directoryHandles.get(directory)?.stop();
    this.#directoryHandles.delete(directory);
    if (!this.#engineProvider && directory === this.#defaultDirectory) {
      this.#eventHandle?.stop();
      this.#eventHandle = null;
    }
    this.#engineProvider?.markSubscribed(directory, false);
    this.#clearReconciliationRetry(directory);
    this.#streamStates.set(directory, "exhausted");
  }

  async #failDirectorySessions(directory: string): Promise<void> {
    const sessionIDs = new Set(this.#recoverySessions(directory));
    for (const session of this.#activeSessions.values()) {
      if (session.directory === directory) {
        sessionIDs.add(session.sessionID);
      }
    }

    const timestamp = Date.now();
    for (const sessionID of sessionIDs) {
      const event: NormalizedAgentEvent = {
        activity: "error",
        error: "The OpenCode event stream could not reconnect.",
        sessionID,
        sourceEventId: `stream-exhausted:${sessionID}`,
        timestamp,
        type: "session.error",
      };
      this.#trackSession(event, directory);
      await this.#broadcastAndWait(event);
    }
    this.#engineProvider?.markReconciled(directory);
  }

  async #reconcileDirectory(directory: string): Promise<void> {
    try {
      const adapter = await this.#adapterFor(directory);
      const recoverySessions = this.#recoverySessions(directory);
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
              return normalizeSessionHistory(sessionID, messages, directory);
            } catch (error) {
              this.#logger.warn("session-history-reconciliation-failed", {
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
          this.#trackSession(event, directory);
          await this.#broadcastAndWait(event);
        }
      }

      const timestamp = Date.now();
      for (const [sessionID, status] of Object.entries(statuses)) {
        const normalized: NormalizedAgentEvent = {
          activity: status.type === "idle" ? "idle" : "thinking",
          sessionID,
          timestamp,
          type: "session.status",
        };
        this.#trackSession(normalized, directory);
        await this.#broadcastAndWait(normalized);
      }

      for (const sessionID of recoverySessions) {
        if (Object.hasOwn(statuses, sessionID)) {
          continue;
        }
        const normalized: NormalizedAgentEvent = {
          activity: "idle",
          sessionID,
          timestamp,
          type: "session.status",
        };
        this.#trackSession(normalized, directory);
        await this.#broadcastAndWait(normalized);
      }

      for (const permission of permissions) {
        await this.#broadcastAndWait({
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
        await this.#broadcastAndWait({
          activity: "waiting_for_question",
          questionID: question.id,
          questions: question.questions,
          sessionID: question.sessionID,
          sourceEventId: `question.asked:${question.id}`,
          timestamp,
          type: "question.asked",
        });
      }
      this.#engineProvider?.markReconciled(directory);
      this.#clearReconciliationRetry(directory);
    } catch (error) {
      this.#logger.error(
        "event-stream-reconciliation-failed",
        error instanceof Error ? error : undefined,
        { directory }
      );
      throw error;
    }
  }

  async createSession(input: SessionCreateInput) {
    const adapter = await this.#adapterFor(
      input.directory ?? this.#defaultDirectory
    );
    return adapter.sessions.create(input);
  }

  /**
   * Reads a session back from the engine.
   *
   * Used to check that a session we are about to reuse really belongs to the
   * directory we are about to work in. The engine is the only authority on that;
   * the store holds a session id and a path but no link between them.
   */
  async getSession(input: {
    directory?: string;
    engineDirectory?: string;
    sessionID: string;
  }) {
    const adapter = await this.#adapterFor(
      input.engineDirectory ?? input.directory ?? this.#defaultDirectory
    );
    return adapter.sessions.get(input.sessionID, input.directory);
  }

  async promptSession(input: SessionPromptInput) {
    const adapter = await this.#adapterFor(
      input.directory ?? this.#defaultDirectory
    );
    return adapter.sessions.prompt(input);
  }

  async promptSessionAsync(input: SessionPromptInput) {
    const adapter = await this.#adapterFor(
      input.directory ?? this.#defaultDirectory
    );
    return adapter.sessions.promptAsync(input);
  }

  async abortSession(sessionID: string, directory?: string) {
    const adapter = await this.#adapterFor(directory ?? this.#defaultDirectory);
    return adapter.sessions.abort(sessionID, directory);
  }

  async sessionDiff(sessionID: string, directory?: string) {
    const target = directory ?? this.#defaultDirectory;
    const adapter = await this.#adapterFor(target);
    return adapter.sessions.diff(sessionID, target);
  }

  async waitForSessionIdle(
    sessionID: string,
    directory: string,
    timeoutMs: number
  ): Promise<boolean> {
    const adapter = await this.#adapterFor(directory);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const statuses = await adapter.sessions.status(directory);
      const status = statuses[sessionID];
      if (!status || status.type === "idle") {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, Math.min(100, deadline - Date.now()));
      });
    }
  }

  async replyPermission(input: PermissionHandlerInput) {
    const adapter = await this.#adapterFor(
      input.directory ?? this.#defaultDirectory
    );
    return adapter.permissions.reply(input);
  }

  async listQuestions(directory?: string): Promise<QuestionRequest[]> {
    const adapter = await this.#adapterFor(directory ?? this.#defaultDirectory);
    return adapter.questions.list(directory);
  }

  async replyQuestion(input: QuestionReplyInput) {
    const adapter = await this.#adapterFor(
      input.directory ?? this.#defaultDirectory
    );
    return adapter.questions.reply(input);
  }

  async rejectQuestion(requestID: string, directory?: string) {
    const adapter = await this.#adapterFor(directory ?? this.#defaultDirectory);
    return adapter.questions.reject(requestID, directory);
  }

  async forkSession(input: SessionForkInput) {
    const adapter = await this.#adapterFor(
      input.directory ?? this.#defaultDirectory
    );
    return adapter.sessions.fork(input);
  }

  async revertSession(sessionID: string, directory?: string) {
    const adapter = await this.#adapterFor(directory ?? this.#defaultDirectory);
    const target = directory ?? this.#defaultDirectory;
    this.#logger.debug("Reverting session", {
      sessionID,
      directory: target,
    });
    return adapter.sessions
      .revert({ sessionID, directory: target })
      .then((result) => {
        this.#logger.info("Session reverted", {
          sessionID,
          messageID: result?.messageID,
          messageIndex: result?.messageIndex,
          totalMessages: result?.totalMessages,
        });
        return result;
      })
      .catch((error: unknown) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        this.#logger.error(
          "Failed to revert session",
          error instanceof Error ? error : undefined,
          {
            sessionID,
            directory: target,
            errorMessage,
            errorStack,
          }
        );
        throw error;
      });
  }

  async unrevertSession(sessionID: string, directory?: string) {
    const adapter = await this.#adapterFor(directory ?? this.#defaultDirectory);
    const target = directory ?? this.#defaultDirectory;
    this.#logger.debug("Unreverting session", {
      sessionID,
      directory: target,
    });
    return adapter.sessions
      .unrevert({ sessionID, directory: target })
      .then((result) => {
        this.#logger.info("Session unreverted", { sessionID });
        return result;
      })
      .catch((error: unknown) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        this.#logger.error(
          "Failed to unrevert session",
          error instanceof Error ? error : undefined,
          {
            sessionID,
            directory: target,
            errorMessage,
            errorStack,
          }
        );
        throw error;
      });
  }

  getStatus(): BridgeStatus {
    return {
      connected:
        (this.#eventHandle !== null || this.#directoryHandles.size > 0) &&
        this.#streamStates.size > 0 &&
        [...this.#streamStates.values()].every(
          (status) => status === "connected"
        ),
      opencodeUrl: this.#baseUrl,
      activeSessions: this.#activeSessions.size,
      subscribedDirectories: [
        this.#defaultDirectory,
        ...this.#directoryHandles.keys(),
      ],
      uptime: Date.now() - this.#startTime,
    };
  }

  async assertReady(): Promise<void> {
    try {
      await this.#ensureEngineReady();
    } catch (error) {
      if (error instanceof EngineUnavailableError) {
        throw error;
      }
      throw new EngineUnavailableError(
        error instanceof Error
          ? error.message
          : "OpenCode engine readiness could not be verified"
      );
    }
  }

  async #adapterFor(directory: string): Promise<OpenCodeAdapter> {
    if (this.#engineProvider) {
      return this.#engineProvider.adapterForDirectory(directory);
    }
    await this.assertReady();
    return this.adapter;
  }

  #removeDirectorySubscription(directory: string): void {
    this.#clearReconciliationRetry(directory);
    const handle = this.#directoryHandles.get(directory);
    if (!handle) {
      return;
    }
    handle.stop();
    this.#directoryHandles.delete(directory);
    this.#streamStates.delete(directory);
    this.#engineProvider?.markSubscribed(directory, false);
  }

  stop(): void {
    this.#eventHandle?.stop();
    this.#eventHandle = null;
    for (const handle of this.#directoryHandles.values()) {
      handle.stop();
    }
    for (const directory of this.#directoryHandles.keys()) {
      this.#engineProvider?.markSubscribed(directory, false);
    }
    this.#directoryHandles.clear();
    for (const timer of this.#reconciliationRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.#reconciliationRetryTimers.clear();
    this.#reconciliationRetryAttempts.clear();
    this.#streamStates.clear();
    this.#subscribers.clear();
    this.#activeSessions.clear();
  }
}
