import type { Logger } from "@chorus/logger";

const SHUTDOWN_TIMEOUT_MS = 5000;

interface ShutdownResources {
  beginEngineShutdown(): void;
  closeRemoteAccess(): Promise<void>;
  closeWorkspaceHub(): void;
  closeWorkspaceStore(): Promise<void>;
  exit(code: number): void;
  forceKillEngines(): void;
  forceKillRemoteAccess(): void;
  logger: Pick<Logger, "error" | "info" | "warn">;
  stopBridge(): void;
  stopEngines(): Promise<void>;
  stopHttpServer(): Promise<void>;
  stopLocalEntry(): Promise<void>;
  stopPushDispatcher(): void;
}

export function createGracefulShutdown(
  resources: ShutdownResources
): (signal: string) => Promise<void> {
  let isShuttingDown = false;
  let phase = "idle";

  return async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    resources.beginEngineShutdown();
    phase = "stopping-dispatcher";
    resources.logger.info("server-shutdown", { signal });

    const timeout = setTimeout(() => {
      resources.logger.warn("shutdown-timeout-force-kill", { phase });
      resources.forceKillRemoteAccess();
      resources.forceKillEngines();
      resources.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      resources.stopPushDispatcher();
      phase = "closing-remote-access";
      await resources.closeRemoteAccess();
      phase = "closing-workspace-hub";
      resources.closeWorkspaceHub();
      phase = "stopping-opencode-bridge";
      resources.stopBridge();
      phase = "stopping-http-server";
      await resources.stopHttpServer();
      phase = "stopping-local-entry";
      await resources.stopLocalEntry();
      phase = "flushing-workspace-store";
      await resources.closeWorkspaceStore();
      phase = "stopping-managed-engines";
      await resources.stopEngines();
      clearTimeout(timeout);
      phase = "complete";
      resources.logger.info("shutdown-complete");
      resources.exit(0);
    } catch (error) {
      resources.logger.error(
        "shutdown-error",
        error instanceof Error ? error : undefined
      );
      clearTimeout(timeout);
      resources.exit(1);
    }
  };
}

export function registerGracefulShutdown(
  resources: Omit<ShutdownResources, "exit">
): void {
  const gracefulShutdown = createGracefulShutdown({
    ...resources,
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}
