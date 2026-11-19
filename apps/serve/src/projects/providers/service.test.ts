import { expect, mock, test } from "bun:test";
import { OpenCodeAdapter } from "@chorus/oc-adapter";
import { ProjectEngineContext } from "../engine-context";
import { ProviderService } from "./service";

function createService() {
  let globalConfig: { provider?: Record<string, unknown> } = {
    provider: { openrouter: {} },
  };
  let configuredDirectory: string | undefined;
  let updatedConfig: { provider?: Record<string, unknown> } | undefined;
  const providerCatalog = {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5": {
            id: "gpt-5",
            name: "GPT-5",
            release_date: "2025-01-01",
            capabilities: {
              attachment: true,
              reasoning: true,
              temperature: true,
              toolcall: true,
            },
            status: "active" as const,
          },
        },
      },
    ],
    default: { openai: "gpt-5" },
    connected: ["openai"],
  };
  const providerList = mock(() => Promise.resolve({ data: providerCatalog }));
  const providerAuth = mock(() =>
    Promise.resolve({
      data: { openai: [{ label: "API key", type: "api" as const }] },
    })
  );
  const getConfig = mock(() => Promise.resolve({ data: globalConfig }));
  const updateConfig = mock(({ config }: { config: typeof globalConfig }) => {
    updatedConfig = config;
    globalConfig = config;
    return Promise.resolve({ data: config });
  });
  const adapter = new OpenCodeAdapter({
    global: {
      config: {
        get: getConfig,
        update: updateConfig,
      },
    },
    provider: {
      list: providerList,
      auth: providerAuth,
    },
  } as never);
  const engine = new ProjectEngineContext({
    baseUrl: "http://127.0.0.1:4096",
    engineAdapterForDirectory: (directory) => {
      configuredDirectory = directory;
      return Promise.resolve(adapter);
    },
    globalAdapter: adapter,
  });
  const service = new ProviderService({
    defaultDirectory: "/host-default",
    engine,
  });

  return {
    getConfig,
    providerAuth,
    providerList,
    service,
    updateConfig,
    values: () => ({ configuredDirectory, globalConfig, updatedConfig }),
  };
}

test("configured providers are read from the application-wide OpenCode config", async () => {
  const fixture = createService();

  await expect(fixture.service.listConfiguredProviders()).resolves.toEqual({
    providerIDs: ["openrouter"],
  });
  expect(fixture.values().configuredDirectory).toBeUndefined();
});

test("global provider status is independent of a board engine", async () => {
  const fixture = createService();

  await expect(fixture.service.listProviders()).resolves.toEqual({
    providers: [
      {
        connected: true,
        id: "openai",
        modelCount: 1,
        name: "OpenAI",
        supportsApi: true,
        supportsOauth: false,
      },
    ],
  });
  expect(fixture.values().configuredDirectory).toBeUndefined();
});

test("global model catalog is independent of a board engine", async () => {
  const fixture = createService();

  const catalog = await fixture.service.listModels();

  expect(catalog.defaultModel).toEqual({
    modelID: "gpt-5",
    providerID: "openai",
  });
  expect(catalog.models).toHaveLength(1);
  expect(fixture.values().configuredDirectory).toBeUndefined();
});

test("global provider setup updates one shared config without a board directory", async () => {
  const fixture = createService();

  await expect(
    fixture.service.configureProvider({ providerID: "anthropic" })
  ).resolves.toBe(true);

  expect(fixture.updateConfig).toHaveBeenCalledTimes(1);
  expect(fixture.values().updatedConfig?.provider).toEqual({
    openrouter: {},
    anthropic: {},
  });
  expect(fixture.values().configuredDirectory).toBeUndefined();
});
