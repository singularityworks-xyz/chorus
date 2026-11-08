import { expect, mock, test } from "bun:test";
import { OpenCodeAdapter } from "@chorus/oc-adapter";
import { ProjectService } from "./service";

function createService() {
  let globalConfig: { provider?: Record<string, unknown> } = {
    provider: { openrouter: {} },
  };
  let configuredDirectory: string | undefined;
  let updatedConfig: { provider?: Record<string, unknown> } | undefined;
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
  } as never);
  const service = new ProjectService(
    "http://127.0.0.1:4096",
    "/host-default",
    { pickFolder: () => Promise.resolve(null) },
    () => Promise.resolve("/unused"),
    undefined,
    undefined,
    (directory) => {
      configuredDirectory = directory;
      return Promise.resolve(adapter);
    },
    () => Promise.resolve()
  );

  return {
    getConfig,
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
  expect(fixture.values().configuredDirectory).toBe("/host-default");
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
  expect(fixture.values().configuredDirectory).toBe("/host-default");
});
