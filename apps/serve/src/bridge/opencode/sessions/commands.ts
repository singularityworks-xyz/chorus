import type { Logger } from "@chorus/logger";
import type {
  OpenCodeAdapter,
  PermissionHandlerInput,
  QuestionReplyInput,
  QuestionRequest,
  SessionCreateInput,
  SessionForkInput,
  SessionPromptInput,
} from "@chorus/oc-adapter";

type AdapterProvider = (directory: string) => Promise<OpenCodeAdapter>;

export class OpenCodeSessionCommands {
  readonly #adapterFor: AdapterProvider;
  readonly #defaultDirectory: string;
  readonly #logger: Logger;

  constructor(
    adapterFor: AdapterProvider,
    defaultDirectory: string,
    logger: Logger
  ) {
    this.#adapterFor = adapterFor;
    this.#defaultDirectory = defaultDirectory;
    this.#logger = logger;
  }

  async createSession(input: SessionCreateInput) {
    const adapter = await this.#adapterFor(
      input.directory ?? this.#defaultDirectory
    );
    return adapter.sessions.create(input);
  }

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
}
