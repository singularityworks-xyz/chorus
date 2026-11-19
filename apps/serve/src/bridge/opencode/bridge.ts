import { createLogger } from "@chorus/logger";
import type {
  EventStreamHandle,
  NormalizedAgentEvent,
  PermissionHandlerInput,
  QuestionReplyInput,
  QuestionRequest,
  SessionCreateInput,
  SessionForkInput,
  SessionPromptInput,
} from "@chorus/oc-adapter";
import { OpenCodeAdapter } from "@chorus/oc-adapter";
import { EngineUnavailableError } from "../../opencode/process-manager/errors";
import { EventStreamReconciler } from "./reconciliation";

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
  readonly #reconciler: EventStreamReconciler;
  #eventHandle: EventStreamHandle | null = null;
  readonly #directoryHandles = new Map<string, EventStreamHandle>();
  readonly #subscribers = new Set<EventSubscriber>();
  readonly #activeSessions = new Map<
    string,
    { activity: string; directory: string; sessionID: string }
  >();
  #recoverySessions: (directory: string) => string[] = () => [];
  readonly #startTime: number;
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
    this.#reconciler = new EventStreamReconciler({
      activeSessionIds: (target) =>
        [...this.#activeSessions.values()]
          .filter((session) => session.directory === target)
          .map((session) => session.sessionID),
      adapterFor: (target) => this.#adapterFor(target),
      markReconciled: (target) => this.#engineProvider?.markReconciled(target),
      onExhausted: (target) => this.#detachExhaustedStream(target),
      publish: async (target, event) => {
        this.#trackSession(event, target);
        await this.#broadcastAndWait(event);
      },
      recoverySessionIds: (target) => this.#recoverySessions(target),
    });
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
    // Pooled engines own their directory streams.
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
          this.#reconciler.onStatus(this.#defaultDirectory, status),
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
          onStatus: (status) => this.#reconciler.onStatus(directory, status),
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

  async createSession(input: SessionCreateInput) {
    const adapter = await this.#adapterFor(
      input.directory ?? this.#defaultDirectory
    );
    return adapter.sessions.create(input);
  }

  // Session ownership is verified by the engine for the requested directory.
  async getSession(input: {
    directory?: string;
    engineDirectory?: string;
    sessionID: string;
  }) {
    const directory =
      input.directory ?? input.engineDirectory ?? this.#defaultDirectory;
    const adapter = await this.#adapterFor(directory);
    return adapter.sessions.get(input.sessionID, directory);
  }

  async sessionMessages(sessionID: string, directory: string) {
    const adapter = await this.#adapterFor(directory);
    return adapter.sessions.messages(sessionID, { directory, limit: 200 });
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

  async listAutocompleteCommands(directory: string) {
    const adapter = await this.#adapterFor(directory);
    return adapter.references.listCommands(directory);
  }

  async listAutocompleteSkills(directory: string) {
    const adapter = await this.#adapterFor(directory);
    return adapter.references.listSkills(directory);
  }

  async findAutocompleteFiles(query: string, directory: string) {
    const adapter = await this.#adapterFor(directory);
    return adapter.references.findFiles(query, directory);
  }

  async listAutocompleteDirectory(path: string, directory: string) {
    const adapter = await this.#adapterFor(directory);
    return adapter.references.listDirectory(path, directory);
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
        this.#reconciler.hasStatus &&
        this.#reconciler.allConnected,
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

  #detachExhaustedStream(directory: string): void {
    this.#directoryHandles.get(directory)?.stop();
    this.#directoryHandles.delete(directory);
    if (!this.#engineProvider && directory === this.#defaultDirectory) {
      this.#eventHandle?.stop();
      this.#eventHandle = null;
    }
    this.#engineProvider?.markSubscribed(directory, false);
  }

  #removeDirectorySubscription(directory: string): void {
    this.#reconciler.removeDirectory(directory);
    const handle = this.#directoryHandles.get(directory);
    if (!handle) {
      return;
    }
    handle.stop();
    this.#directoryHandles.delete(directory);
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
    this.#reconciler.stop();
    this.#subscribers.clear();
    this.#activeSessions.clear();
  }
}
