import type {
  AgentPartInput,
  FilePartInput,
  OpencodeClient,
  OutputFormat,
  Session,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2";

/**
 * Unwraps a generated-client response, keeping the failure legible.
 *
 * The client does not throw on a failed request — it resolves with
 * `{ error: { code, path, ... } }` and `data` undefined. Throwing "returned no
 * data" for that case is actively harmful: a connection refused to the engine was
 * reported as a missing payload, which reads like a version or parsing problem
 * and sent the investigation at the wrong layer entirely. Name the real error.
 */
function unwrap<T>(
  result: { data?: T; error?: unknown },
  operation: string
): T {
  if (result.data !== undefined) {
    return result.data;
  }

  if (result.error !== undefined) {
    throw new Error(
      `OpenCode ${operation} failed: ${describeError(result.error)}`
    );
  }

  throw new Error(`OpenCode ${operation} returned no data and no error`);
}

/** The human-readable part of a client error, when it carries one. */
function errorDetail(record: Record<string, unknown>): string {
  if (typeof record.message === "string") {
    return `: ${record.message}`;
  }
  if (typeof record.data === "string") {
    return `: ${record.data}`;
  }
  return "";
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "Error";
    const path = typeof record.path === "string" ? ` (${record.path})` : "";
    return `${code}${path}${errorDetail(record)}`;
  }

  return String(error);
}

export interface SessionCreateInput {
  directory?: string;
  parentID?: string;
  title?: string;
  workspaceID?: string;
}

export interface SessionPromptInput {
  agent?: string;
  directory?: string;
  format?: OutputFormat;
  model?: {
    providerID: string;
    modelID: string;
  };
  noReply?: boolean;
  parts?: Array<
    TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
  >;
  sessionID: string;
  system?: string;
  text: string;
  variant?: string;
  workspace?: string;
}

export interface SessionPromptAsyncInput {
  agent?: string;
  directory?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  parts?: Array<
    TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
  >;
  sessionID: string;
  system?: string;
  text: string;
  variant?: string;
  workspace?: string;
}

export interface SessionCommandInput {
  agent?: string;
  arguments?: string;
  command: string;
  directory?: string;
  model?: string;
  sessionID: string;
  workspace?: string;
}

export interface SessionForkInput {
  directory?: string;
  messageID?: string;
  sessionID: string;
  workspace?: string;
}

export interface SessionRevertInput {
  directory?: string;
  sessionID: string;
  workspace?: string;
}

export class SessionManager {
  readonly client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async create(input: SessionCreateInput): Promise<Session> {
    const result = await this.client.session.create({
      title: input.title,
      parentID: input.parentID,
      directory: input.directory,
      workspaceID: input.workspaceID,
    });
    return unwrap(result, "session.create");
  }

  async get(sessionID: string, directory?: string): Promise<Session> {
    const result = await this.client.session.get({
      sessionID,
      directory,
    });
    return unwrap(result, "session.get");
  }

  async list(options?: {
    directory?: string;
    roots?: boolean;
    search?: string;
    limit?: number;
  }): Promise<Session[]> {
    const result = await this.client.session.list({
      directory: options?.directory,
      roots: options?.roots,
      search: options?.search,
      limit: options?.limit,
    });
    return unwrap(result, "session.list");
  }

  async delete(sessionID: string, directory?: string): Promise<boolean> {
    const result = await this.client.session.delete({ sessionID, directory });
    return unwrap(result, "session.delete");
  }

  async abort(sessionID: string, directory?: string): Promise<boolean> {
    const result = await this.client.session.abort({ sessionID, directory });
    return unwrap(result, "session.abort");
  }

  async prompt(input: SessionPromptInput) {
    const parts = input.parts ?? [{ type: "text" as const, text: input.text }];
    const result = await this.client.session.prompt({
      sessionID: input.sessionID,
      directory: input.directory,
      workspace: input.workspace,
      model: input.model,
      agent: input.agent,
      parts,
      format: input.format,
      system: input.system,
      noReply: input.noReply,
      variant: input.variant,
    });
    return unwrap(result, "session.prompt");
  }

  async promptAsync(input: SessionPromptAsyncInput) {
    const parts = input.parts ?? [{ type: "text" as const, text: input.text }];
    const result = await this.client.session.promptAsync({
      sessionID: input.sessionID,
      directory: input.directory,
      workspace: input.workspace,
      model: input.model,
      agent: input.agent,
      parts,
      system: input.system,
      variant: input.variant,
    });

    // The generated client resolves `{ error }` rather than throwing, so ignoring
    // the result means a prompt that never reached the engine still reports
    // `accepted: true` back through the queue response.
    if (result.error !== undefined) {
      throw new Error(
        `OpenCode session.promptAsync failed: ${describeError(result.error)}`
      );
    }
  }

  async command(input: SessionCommandInput) {
    const result = await this.client.session.command({
      sessionID: input.sessionID,
      directory: input.directory,
      workspace: input.workspace,
      command: input.command,
      arguments: input.arguments,
      agent: input.agent,
      model: input.model,
    });
    return unwrap(result, "session.command");
  }

  async fork(input: SessionForkInput): Promise<Session> {
    const result = await this.client.session.fork({
      sessionID: input.sessionID,
      directory: input.directory,
      workspace: input.workspace,
      messageID: input.messageID,
    });
    return unwrap(result, "session.fork");
  }

  async status(directory?: string): Promise<Record<string, { type: string }>> {
    const result = await this.client.session.status({ directory });
    return result.data ?? {};
  }

  async messages(
    sessionID: string,
    options?: { limit?: number; directory?: string }
  ) {
    const result = await this.client.session.messages({
      sessionID,
      limit: options?.limit,
      directory: options?.directory,
    });
    return unwrap(result, "session.messages");
  }

  async summarize(
    sessionID: string,
    options?: { providerID?: string; modelID?: string }
  ) {
    await this.client.session.summarize({
      sessionID,
      providerID: options?.providerID,
      modelID: options?.modelID,
    });
  }

  async revert(input: SessionRevertInput) {
    const messages = await this.messages(input.sessionID, {
      directory: input.directory,
    });

    const sessionResult = await this.get(input.sessionID);
    const hasExistingRevert = sessionResult?.revert != null;

    if (hasExistingRevert) {
      throw new Error(
        `Session already has a pending revert state (messageID: ${sessionResult.revert?.messageID}). Unrevert first or send a new prompt.`
      );
    }

    let lastUserMessageID: string | undefined;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info.role === "user") {
        lastUserMessageID = msg.info.id;
        lastUserIndex = i;
        break;
      }
    }

    if (!lastUserMessageID) {
      throw new Error("No user message found to revert to");
    }

    const result = await this.client.session.revert({
      sessionID: input.sessionID,
      directory: input.directory,
      workspace: input.workspace,
      messageID: lastUserMessageID,
    });

    const revertedSession = unwrap(result, "session.revert");

    return {
      session: revertedSession,
      messageID: lastUserMessageID,
      messageIndex: lastUserIndex,
      totalMessages: messages.length,
    };
  }

  async unrevert(input: SessionRevertInput) {
    const sessionResult = await this.get(input.sessionID);
    const hasRevertState = sessionResult?.revert != null;

    if (!hasRevertState) {
      throw new Error("No revert state to unrevert. Nothing to restore.");
    }

    const result = await this.client.session.unrevert({
      sessionID: input.sessionID,
      directory: input.directory,
      workspace: input.workspace,
    });
    return unwrap(result, "session.unrevert");
  }
}
