import type { OpencodeClient, PermissionRequest } from "@opencode-ai/sdk/v2";

export type { PermissionRequest } from "@opencode-ai/sdk/v2";

export type PermissionReply = "once" | "always" | "reject";

export interface PermissionHandlerInput {
  directory?: string;
  message?: string;
  reply: PermissionReply;
  requestID: string;
  sessionID: string;
}

export class PermissionHandler {
  readonly client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async reply(input: PermissionHandlerInput): Promise<boolean> {
    const result = await this.client.permission.reply({
      requestID: input.requestID,
      reply: input.reply,
      message: input.message,
      directory: input.directory,
    });
    return result.data ?? false;
  }

  async list(directory?: string): Promise<PermissionRequest[]> {
    const result = await this.client.permission.list({ directory });
    return result.data ?? [];
  }
}
