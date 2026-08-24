import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger } from "@chorus/logger";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { OpenCodeBridge } from "./bridge/opencode/bridge";
import { loadConfig } from "./config";
import { createWsClientManager } from "./events/broadcaster";
import { OpenCodeProcessManager } from "./opencode/process-manager";
import { NativeFolderPicker } from "./projects/folder-picker";
import { ProjectService } from "./projects/service";
import { createHttpRoutes } from "./routes";
import { createProjectRoutes } from "./routes/projects";
import { voiceRoutes } from "./routes/voice";
import { createWorkspaceRoutes } from "./routes/workspace";
import { BoardTaskService } from "./tasks/board-task-service";
import { SessionWatchdog } from "./tasks/session-watchdog";
import { serveWebFrontend } from "./web-frontend";
import { WorkspaceStore } from "./workspace/store";
import { createWsHandler } from "./ws/handler";

const config = loadConfig();
const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "SERVE"
);

const processManager = new OpenCodeProcessManager({
  directory: config.opencodeDirectory,
});

if (config.autoStartOpencode) {
  await processManager.start();
}

const bridge = new OpenCodeBridge(
  config.opencodeBaseUrl,
  config.opencodeDirectory
);
const wsManager = createWsClientManager();

async function resolveWorkspaceSnapshotPath() {
  const homeWorkspaceDir = path.join(homedir(), ".chorus");
  const homeWorkspacePath = path.join(homeWorkspaceDir, "workspace.json");
  const legacyWorkspacePath = path.join(
    process.cwd(),
    ".chorus",
    "workspace.json"
  );

  await mkdir(homeWorkspaceDir, { recursive: true });

  try {
    await access(homeWorkspacePath);
    return homeWorkspacePath;
  } catch {
    // No home snapshot yet. Fall through to migration check.
  }

  try {
    await access(legacyWorkspacePath);
    await copyFile(legacyWorkspacePath, homeWorkspacePath);
    await rm(legacyWorkspacePath, { force: true });
    logger.info("workspace-snapshot-migrated", {
      from: legacyWorkspacePath,
      to: homeWorkspacePath,
    });
  } catch {
    // No legacy snapshot to migrate.
  }

  return homeWorkspacePath;
}

const workspaceStore = new WorkspaceStore(await resolveWorkspaceSnapshotPath());
await workspaceStore.load();

const watchdog = new SessionWatchdog(bridge, {
  onTimeout: (sessionId, info, message) => {
    logger.warn("watchdog-timeout", {
      sessionId,
      boardId: info.boardId,
      message,
    });

    workspaceStore
      .applyAgentEvent({
        type: "session.timeout",
        sessionID: sessionId,
        activity: "error",
        error: message,
        timestamp: Date.now(),
      })
      .then((snapshot) => {
        if (!snapshot) {
          return;
        }
        const board = snapshot.boards.find(
          (b) => b.session.sessionId === sessionId
        );
        logger.info("workspace-snapshot-after-timeout", {
          sessionID: sessionId,
          boardId: board?.boardId,
        });
        wsManager.broadcastRaw(
          JSON.stringify({
            type: "workspace.updated",
            payload: snapshot,
            timestamp: Date.now(),
          })
        );
      })
      .catch((error) => {
        logger.error(
          "workspace-projection-failed-timeout",
          error instanceof Error ? error : undefined,
          { sessionID: sessionId }
        );
      });
  },
});

const boardTasks = new BoardTaskService(
  bridge,
  workspaceStore,
  undefined,
  watchdog
);
const projectService = new ProjectService(
  config.opencodeBaseUrl,
  config.opencodeDirectory,
  new NativeFolderPicker()
);

bridge.subscribe((event) => {
  wsManager.broadcast(event);

  if (event.type === "server.heartbeat") {
    return;
  }

  logger.debug("bridge-event", {
    type: event.type,
    ...(event.sessionID && { sessionID: event.sessionID }),
    ...(event.activity && { activity: event.activity }),
    ...(event.text && { textPreview: event.text.slice(0, 80) }),
  });

  if (!(event.sessionID && event.activity)) {
    return;
  }

  watchdog.reset(event.sessionID);

  workspaceStore
    .applyAgentEvent(event)
    .then((snapshot) => {
      if (!snapshot) {
        return;
      }

      const board = snapshot.boards.find(
        (b) => b.session.sessionId === event.sessionID
      );

      logger.info("workspace-snapshot-broadcast", {
        sessionID: event.sessionID,
        revision: snapshot.revision,
        boardId: board?.boardId,
        taskCount: board
          ? Object.values(board.columns).reduce(
              (sum, tasks) => sum + tasks.length,
              0
            )
          : 0,
        steps: board
          ? Object.values(board.columns)
              .flat()
              .filter((t) => t.run)
              .flatMap((t) => t.run?.steps ?? [])
              .map((s) => ({
                kind: s.kind,
                summary: s.summary,
                status: s.status,
              }))
          : [],
      });

      wsManager.broadcastRaw(
        JSON.stringify({
          type: "workspace.updated",
          payload: snapshot,
          timestamp: Date.now(),
        })
      );
    })
    .catch((error) => {
      logger.error(
        "workspace-projection-failed",
        error instanceof Error ? error : undefined,
        {
          sessionID: event.sessionID,
          eventType: event.type,
        }
      );
    });
});

const app = new Elysia()
  .use(cors())
  .onStart(() => {
    logger.info("server-starting", { port: config.port });
  })
  .onError(({ error, code }) => {
    logger.error(
      `server-error: ${code}`,
      error instanceof Error ? error : undefined
    );
  })
  // Web frontend routes
  .get("/", () => serveWebFrontend("/"))
  .get("/*", ({ request }) => {
    const url = new URL(request.url);
    return serveWebFrontend(url.pathname);
  })
  // API routes
  .use(createHttpRoutes(bridge, boardTasks, wsManager))
  .use(createProjectRoutes(projectService))
  .use(createWorkspaceRoutes(workspaceStore, wsManager))
  .use(voiceRoutes)
  .use(createWsHandler(bridge, wsManager, boardTasks))
  .listen(config.port);

logger.info("server-running", {
  host: app.server?.hostname,
  port: app.server?.port,
  opencode: config.opencodeBaseUrl,
  directory: config.opencodeDirectory,
  ws: `ws://${app.server?.hostname}:${app.server?.port}/ws`,
});

try {
  await bridge.start();
  logger.info("bridge-connected", { url: config.opencodeBaseUrl });
} catch (error) {
  logger.error("bridge-failed", error instanceof Error ? error : undefined, {
    url: config.opencodeBaseUrl,
  });
}

const SHUTDOWN_TIMEOUT_MS = 5000;
let isShuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info("server-shutdown", { signal });

  const shutdownTimeout = setTimeout(() => {
    logger.warn("shutdown-timeout-force-kill");
    forceKillOpencode();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    wsManager.close();
    bridge.stop();
    processManager.stop();
    app.server?.stop();
    clearTimeout(shutdownTimeout);
    logger.info("shutdown-complete");
    process.exit(0);
  } catch (error) {
    logger.error("shutdown-error", error instanceof Error ? error : undefined);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

function forceKillOpencode(): void {
  processManager.forceKill();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
