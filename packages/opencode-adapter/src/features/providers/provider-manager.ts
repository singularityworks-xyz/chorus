import type { OpencodeClient } from "@opencode-ai/sdk/v2";

export interface OpencodeModelSummary {
  attachment: boolean;
  connected: boolean;
  modelID: string;
  name: string;
  providerID: string;
  providerName: string;
  reasoning: boolean;
  releaseDate: string;
  status?: "active" | "alpha" | "beta" | "deprecated";
  temperature: boolean;
  toolCall: boolean;
}

export interface OpencodeModelCatalog {
  defaultModel?: {
    modelID: string;
    providerID: string;
  };
  models: OpencodeModelSummary[];
}

export interface OpencodeProviderStatus {
  connected: boolean;
  id: string;
  modelCount: number;
  name: string;
  supportsApi: boolean;
  supportsOauth: boolean;
}

export interface OpencodeProviderCatalog {
  providers: OpencodeProviderStatus[];
}

export interface OpencodeProviderAuthPromptText {
  key: string;
  message: string;
  placeholder?: string;
  type: "text";
  when?: {
    key: string;
    op: "eq" | "neq";
    value: string;
  };
}

export interface OpencodeProviderAuthPromptSelect {
  key: string;
  message: string;
  options: Array<{
    hint?: string;
    label: string;
    value: string;
  }>;
  type: "select";
  when?: {
    key: string;
    op: "eq" | "neq";
    value: string;
  };
}

export interface OpencodeProviderAuthMethod {
  label: string;
  prompts?: Array<
    OpencodeProviderAuthPromptText | OpencodeProviderAuthPromptSelect
  >;
  type: "oauth" | "api";
}

export interface OpencodeProviderAuthCatalog {
  methods: OpencodeProviderAuthMethod[];
}

export interface OpencodeProviderOauthAuthorization {
  instructions: string;
  method: "auto" | "code";
  url: string;
}

export class ProviderManager {
  readonly client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async listModels(_input?: {
    directory?: string;
    workspace?: string;
  }): Promise<OpencodeModelCatalog> {
    const result = await this.client.provider.list();

    const providers = result.data;
    if (!providers) {
      return {
        models: [],
      };
    }

    const connected = new Set(providers.connected);
    const models = providers.all
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          // SDK 1.18 moved these four from flat model fields into a nested
          // `capabilities` object, and renamed `tool_call` to `toolcall` while
          // doing it. They stay booleans with the same meaning, so
          // `OpencodeModelSummary` is unchanged and nothing downstream — the
          // model picker reads all four — has to know the engine reshaped them.
          attachment: model.capabilities.attachment,
          connected: connected.has(provider.id),
          modelID: model.id,
          name: model.name,
          providerID: provider.id,
          providerName: provider.name,
          reasoning: model.capabilities.reasoning,
          releaseDate: model.release_date,
          status: model.status,
          temperature: model.capabilities.temperature,
          toolCall: model.capabilities.toolcall,
        }))
      )
      .sort((left, right) => {
        if (left.connected !== right.connected) {
          return left.connected ? -1 : 1;
        }

        if (left.providerName !== right.providerName) {
          return left.providerName.localeCompare(right.providerName);
        }

        return left.name.localeCompare(right.name);
      });

    const defaultProviderID = Object.keys(providers.default)[0];
    const defaultModelID = defaultProviderID
      ? providers.default[defaultProviderID]
      : undefined;

    return {
      defaultModel:
        defaultProviderID && defaultModelID
          ? {
              providerID: defaultProviderID,
              modelID: defaultModelID,
            }
          : undefined,
      models,
    };
  }

  async listProviders(input?: {
    directory?: string;
    workspace?: string;
  }): Promise<OpencodeProviderCatalog> {
    const [providersResult, authResult] = await Promise.all([
      this.client.provider.list({
        directory: input?.directory,
        workspace: input?.workspace,
      }),
      this.client.provider.auth({
        directory: input?.directory,
        workspace: input?.workspace,
      }),
    ]);

    const providers = providersResult.data;
    const authMethods = authResult.data ?? {};
    if (!providers) {
      return {
        providers: [],
      };
    }

    const connected = new Set(providers.connected);

    return {
      providers: providers.all
        .map((provider) => {
          const methods = authMethods[provider.id] ?? [];

          return {
            connected: connected.has(provider.id),
            id: provider.id,
            modelCount: Object.keys(provider.models).length,
            name: provider.name,
            supportsApi: methods.some((method) => method.type === "api"),
            supportsOauth: methods.some((method) => method.type === "oauth"),
          };
        })
        .sort((left, right) => {
          if (left.connected !== right.connected) {
            return left.connected ? -1 : 1;
          }

          return left.name.localeCompare(right.name);
        }),
    };
  }

  async getAuthMethods(input: {
    directory?: string;
    providerID: string;
    workspace?: string;
  }): Promise<OpencodeProviderAuthCatalog> {
    const result = await this.client.provider.auth({
      directory: input.directory,
      workspace: input.workspace,
    });

    return {
      methods: result.data?.[input.providerID] ?? [],
    };
  }

  async authorizeOauth(input: {
    directory?: string;
    inputs?: Record<string, string>;
    method: number;
    providerID: string;
    workspace?: string;
  }): Promise<OpencodeProviderOauthAuthorization> {
    const result = await this.client.provider.oauth.authorize({
      providerID: input.providerID,
      directory: input.directory,
      workspace: input.workspace,
      method: input.method,
      inputs: input.inputs,
    });

    if (!result.data) {
      throw new Error("OpenCode provider oauth authorize returned no data");
    }

    return result.data;
  }

  async completeOauth(input: {
    code: string;
    directory?: string;
    method: number;
    providerID: string;
    workspace?: string;
  }): Promise<boolean> {
    const result = await this.client.provider.oauth.callback({
      providerID: input.providerID,
      directory: input.directory,
      workspace: input.workspace,
      method: input.method,
      code: input.code,
    });

    return result.data ?? false;
  }

  async setApiAuth(input: {
    directory?: string;
    key: string;
    providerID: string;
  }): Promise<boolean> {
    const result = await this.client.auth.set({
      providerID: input.providerID,
      auth: {
        type: "api",
        key: input.key,
      },
    });

    return result.data ?? false;
  }
}
