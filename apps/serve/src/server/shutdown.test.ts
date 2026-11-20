import { describe, expect, test } from "bun:test";
import { createGracefulShutdown } from "./shutdown";

describe("graceful shutdown", () => {
  test("stops intake, flushes state, then stops engines", async () => {
    const steps: string[] = [];
    const shutdown = createGracefulShutdown({
      beginEngineShutdown: () => steps.push("begin-engines"),
      closeRemoteAccess: () => {
        steps.push("close-remote");
        return Promise.resolve();
      },
      closeWorkspaceHub: () => steps.push("close-hub"),
      closeWorkspaceStore: () => {
        steps.push("close-store");
        return Promise.resolve();
      },
      exit: (code) => steps.push(`exit:${code}`),
      forceKillEngines: () => steps.push("force-kill-engines"),
      forceKillRemoteAccess: () => steps.push("force-kill-remote"),
      logger: {
        error: (message) => steps.push(`error:${message}`),
        info: (message) => steps.push(`info:${message}`),
        warn: (message) => steps.push(`warn:${message}`),
      },
      stopBridge: () => steps.push("stop-bridge"),
      stopHttpServer: () => {
        steps.push("stop-http");
        return Promise.resolve();
      },
      stopLocalEntry: () => {
        steps.push("stop-local-entry");
        return Promise.resolve();
      },
      stopPushDispatcher: () => steps.push("stop-push"),
      stopEngines: () => {
        steps.push("stop-engines");
        return Promise.resolve();
      },
    });

    await shutdown("SIGTERM");

    expect(steps).toEqual([
      "begin-engines",
      "info:server-shutdown",
      "stop-push",
      "close-remote",
      "close-hub",
      "stop-bridge",
      "stop-http",
      "stop-local-entry",
      "close-store",
      "stop-engines",
      "info:shutdown-complete",
      "exit:0",
    ]);

    await shutdown("SIGINT");
    expect(steps).toHaveLength(12);
  });

  test("exits with failure when a shutdown stage throws", async () => {
    const steps: string[] = [];
    const shutdown = createGracefulShutdown({
      beginEngineShutdown: () => steps.push("begin-engines"),
      closeRemoteAccess: () => Promise.reject(new Error("remote close failed")),
      closeWorkspaceHub: () => steps.push("close-hub"),
      closeWorkspaceStore: () => {
        steps.push("close-store");
        return Promise.resolve();
      },
      exit: (code) => steps.push(`exit:${code}`),
      forceKillEngines: () => steps.push("force-kill-engines"),
      forceKillRemoteAccess: () => steps.push("force-kill-remote"),
      logger: {
        error: (message) => steps.push(`error:${message}`),
        info: (message) => steps.push(`info:${message}`),
        warn: (message) => steps.push(`warn:${message}`),
      },
      stopBridge: () => steps.push("stop-bridge"),
      stopHttpServer: () => {
        steps.push("stop-http");
        return Promise.resolve();
      },
      stopLocalEntry: () => {
        steps.push("stop-local-entry");
        return Promise.resolve();
      },
      stopPushDispatcher: () => steps.push("stop-push"),
      stopEngines: () => {
        steps.push("stop-engines");
        return Promise.resolve();
      },
    });

    await shutdown("SIGTERM");

    expect(steps).toEqual([
      "begin-engines",
      "info:server-shutdown",
      "stop-push",
      "error:shutdown-error",
      "exit:1",
    ]);
  });
});
