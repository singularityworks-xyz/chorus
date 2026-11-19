import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2";

function unwrap<T>(
  result: { data?: T; error?: unknown },
  operation: string
): T {
  if (result.data !== undefined) {
    return result.data;
  }

  const errorCode =
    typeof result.error === "object" &&
    result.error !== null &&
    "code" in result.error &&
    typeof result.error.code === "string"
      ? ` (${result.error.code})`
      : "";
  if (result.error !== undefined) {
    throw new Error(`OpenCode ${operation} failed${errorCode}`);
  }

  throw new Error(`OpenCode ${operation} returned no data and no error`);
}

export class ConfigManager {
  readonly client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async get(input?: {
    directory?: string;
    workspace?: string;
  }): Promise<Config> {
    const result = await this.client.config.get({
      directory: input?.directory,
      workspace: input?.workspace,
    });

    return unwrap(result, "config.get");
  }

  async getGlobal(): Promise<Config> {
    const result = await this.client.global.config.get();
    return unwrap(result, "global.config.get");
  }

  async listConfiguredProviders(): Promise<{ providerIDs: string[] }> {
    const config = await this.getGlobal();
    return {
      providerIDs: Object.keys(config.provider ?? {}).sort((left, right) =>
        left.localeCompare(right)
      ),
    };
  }

  async updateGlobal(config: Config): Promise<Config> {
    const result = await this.client.global.config.update({
      config,
    });

    return unwrap(result, "global.config.update");
  }

  async configureGlobalProvider(providerID: string): Promise<Config> {
    const current = await this.getGlobal();

    const provider = {
      ...(current.provider ?? {}),
      [providerID]: current.provider?.[providerID] ?? {},
    };

    const disabledProviders = (current.disabled_providers ?? []).filter(
      (disabledProviderID) => disabledProviderID !== providerID
    );

    return this.updateGlobal({
      ...current,
      provider,
      disabled_providers:
        disabledProviders.length > 0 ? disabledProviders : undefined,
    });
  }
}
