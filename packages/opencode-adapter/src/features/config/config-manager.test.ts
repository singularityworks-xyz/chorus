import { describe, expect, mock, test } from "bun:test";
import { ConfigManager } from "./config-manager";

function managerForGlobalConfig(response: unknown) {
  const update = mock(async () => ({ data: {} }));
  const get = mock(async () => response);
  const manager = new ConfigManager({
    global: { config: { get, update } },
  } as never);
  return { get, manager, update };
}

describe("ConfigManager global provider settings", () => {
  test("lists configured providers through OpenCode's parsed global config", async () => {
    const { manager } = managerForGlobalConfig({
      data: {
        provider: {
          zeta: {},
          anthropic: {},
        },
      },
    });

    await expect(manager.listConfiguredProviders()).resolves.toEqual({
      providerIDs: ["anthropic", "zeta"],
    });
  });

  test("does not treat a failed global config read as an empty config", async () => {
    const { manager, update } = managerForGlobalConfig({
      error: { code: "Forbidden" },
    });

    await expect(manager.configureGlobalProvider("anthropic")).rejects.toThrow(
      "OpenCode global.config.get failed (Forbidden)"
    );
    expect(update).not.toHaveBeenCalled();
  });

  test("does not report a global update as successful when OpenCode rejects it", async () => {
    const update = mock(async () => ({ error: { code: "InternalError" } }));
    const manager = new ConfigManager({
      global: {
        config: {
          get: async () => ({ data: {} }),
          update,
        },
      },
    } as never);

    await expect(manager.configureGlobalProvider("anthropic")).rejects.toThrow(
      "OpenCode global.config.update failed (InternalError)"
    );
  });

  test("rejects responses with neither config data nor an engine error", async () => {
    const { manager } = managerForGlobalConfig({});

    await expect(manager.listConfiguredProviders()).rejects.toThrow(
      "OpenCode global.config.get returned no data and no error"
    );
  });
});
