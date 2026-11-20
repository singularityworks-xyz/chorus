import type { Logger } from "@chorus/logger";
import { startLocalEntry } from "../../auth/local-entry";
import type { SessionRegistry } from "../../auth/session-registry";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { ServerConfig } from "../../config";
import type { HostRemoteAccess } from "../../hosting/remote-access";
import type { EngineRegistry } from "../../opencode/engine-registry";
import type { OpenCodeProcessManager } from "../../opencode/process-manager/manager";
import type { PushDispatcher } from "../../push/dispatcher";
import type { WorkspaceStore } from "../../workspace/store";
import type { WorkspaceHub } from "../../ws/hub";
import { registerGracefulShutdown } from "../shutdown";
import type { createHttpApplication } from "./http-application";
import { recoverBoardSessions } from "./recover-sessions";

type HttpApplication = ReturnType<typeof createHttpApplication>;

export async function startServeServer({
  app,
  bridge,
  config,
  engineRegistry,
  logger,
  processManager,
  pushDispatcher,
  remoteAccess,
  sessionRegistry,
  token,
  workspaceHub,
  workspaceStore,
}: {
  app: HttpApplication;
  bridge: OpenCodeBridge;
  config: ServerConfig;
  engineRegistry: EngineRegistry | null;
  logger: Logger;
  processManager: OpenCodeProcessManager | null;
  pushDispatcher: PushDispatcher;
  remoteAccess: HostRemoteAccess;
  sessionRegistry: SessionRegistry;
  token: string;
  workspaceHub: WorkspaceHub;
  workspaceStore: WorkspaceStore;
}): Promise<void> {
  try {
    await bridge.start();
    logger.info(
      engineRegistry ? "bridge-started-with-engine-pool" : "bridge-connected",
      { url: config.opencodeBaseUrl }
    );
  } catch (error) {
    logger.error("bridge-failed", error instanceof Error ? error : undefined, {
      url: config.opencodeBaseUrl,
    });
  }

  await recoverBoardSessions({ bridge, logger, workspaceStore });

  let localEntry: ReturnType<typeof startLocalEntry> | null = null;
  try {
    if (config.localEntryEnabled) {
      localEntry = startLocalEntry({
        token,
        registry: sessionRegistry,
      });
    }
    app.listen({ hostname: config.bindAddress, port: config.port });
  } catch (error) {
    pushDispatcher.stop();
    workspaceHub.close();
    bridge.stop();
    await localEntry?.stop(true);
    await remoteAccess.close();
    await workspaceStore.close();
    await Promise.all([processManager?.stop(), engineRegistry?.stop()]);
    throw error;
  }

  logger.info("server-running", {
    host: app.server?.hostname,
    port: app.server?.port,
    opencode: config.opencodeBaseUrl,
    directory: config.opencodeDirectory,
    ws: `ws://${app.server?.hostname}:${app.server?.port}/ws`,
  });

  registerGracefulShutdown({
    beginEngineShutdown: () => {
      processManager?.beginShutdown();
      engineRegistry?.beginShutdown();
    },
    closeRemoteAccess: () => remoteAccess.close(),
    closeWorkspaceHub: () => workspaceHub.close(),
    closeWorkspaceStore: () => workspaceStore.close(),
    forceKillEngines: () => {
      processManager?.forceKill().catch(() => undefined);
      engineRegistry?.forceKill().catch(() => undefined);
    },
    forceKillRemoteAccess: () => remoteAccess.forceKill(),
    logger,
    stopBridge: () => bridge.stop(),
    stopHttpServer: async () => {
      await app.server?.stop(true);
    },
    stopLocalEntry: async () => {
      await localEntry?.stop(true);
    },
    stopPushDispatcher: () => pushDispatcher.stop(),
    stopEngines: async () => {
      await Promise.all([
        processManager?.stop() ?? Promise.resolve(),
        engineRegistry?.stop() ?? Promise.resolve(),
      ]);
    },
  });
}
