import path from "node:path";
import { sdkVersion } from "@chorus/oc-adapter";
import { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { ServerConfig } from "../../config";
import { EngineRegistry } from "../../opencode/engine-registry";
import { OpenCodeProcessManager } from "../../opencode/process-manager/manager";
import { assertEngineLockstep } from "../../paths/engine-lockstep";

export async function createEngineRuntime(config: ServerConfig) {
  const engineAuth =
    config.opencodeUsername && config.opencodePassword
      ? {
          password: config.opencodePassword,
          username: config.opencodeUsername,
        }
      : undefined;
  const processManager = config.opencodePerWorktree
    ? null
    : new OpenCodeProcessManager({
        baseUrl: config.opencodeBaseUrl,
        databasePath: path.resolve(config.dataDir, "opencode.db"),
        directory: config.opencodeDirectory,
        port: config.opencodePort,
        username: config.opencodeUsername,
        password: config.opencodePassword,
        expectedVersion: sdkVersion(),
      });
  const engineRegistry = config.opencodePerWorktree
    ? new EngineRegistry({
        databasePath: path.resolve(config.dataDir, "opencode.db"),
        expectedVersion: sdkVersion(),
        username: config.opencodeUsername,
        password: config.opencodePassword,
      })
    : null;

  if (config.autoStartOpencode && processManager) {
    await processManager.start();
  }

  if (processManager) {
    const engineVersion = config.autoStartOpencode
      ? processManager.observedVersion
      : await processManager.probeVersion();
    assertEngineLockstep(sdkVersion(), engineVersion);
  }

  const bridge = new OpenCodeBridge(
    config.opencodeBaseUrl,
    config.opencodeDirectory,
    engineAuth,
    {
      ...(engineRegistry ? { engineProvider: engineRegistry } : {}),
      ...(processManager
        ? { ensureEngineReady: () => processManager.assertReady(sdkVersion()) }
        : {}),
    }
  );

  return { bridge, engineAuth, engineRegistry, processManager };
}
