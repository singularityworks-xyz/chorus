import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger } from "@chorus/logger";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { OpenCodeBridge } from "./bridge/opencode/bridge";
import { loadConfig } from "./config";
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
import { WorkspaceHub } from "./ws/hub";

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

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-Phase-2 workspace snapshots, imported once into SQLite.
 *
 * Both locations are checked: `~/.chorus/workspace.json` where the old store
 * wrote, and `./.chorus/workspace.json` from the pre-`~/.chorus` era. The
 * importer renames whichever it consumes to `.imported` rather than deleting
 * it, so the operator decides when the migration is trustworthy.
 */
function legacySnapshotPaths(): string[] {
  return [
    path.join(homedir(), ".chorus", "workspace.json"),
    path.join(process.cwd(), ".chorus", "workspace.json"),
  ];
}

const workspaceStore = new WorkspaceStore(config.dataDir, {
  dbSizeCapMb: config.dbSizeCapMb,
  retentionDays: config.retentionDays,
  snapshotInterval: config.snapshotInterval,
});

await mkdir(config.dataDir, { recursive: true });

if (config.enableLegacyWorkspaceImport) {
  for (const candidate of legacySnapshotPaths()) {
    if (await fileExists(candidate)) {
      await workspaceStore.load(candidate);
      logger.info("workspace-legacy-import-attempted", { from: candidate });
      break;
    }
  }
} else {
  await workspaceStore.load();
}

logger.info("workspace-ready", {
  dataDir: config.dataDir,
  database: workspaceStore.databasePath,
  headSeq: workspaceStore.headSeq(),
});

/**
 * The one downstream emit path (spec §3).
 *
 * Subscribing here rather than at each call site is the point: HTTP routes,
 * the opencode bridge, the session watchdog, and the task service all mutate
 * the store through its serial queue, so all of them reach the hub without any
 * of them holding a socket reference or remembering to broadcast.
 */
const hub = new WorkspaceHub(workspaceStore, {
  coalesceMs: config.coalesceMs,
});

workspaceStore.onCommit((commit) => {
  hub.publish(commit);
});

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
      .then((commit) => {
        if (!commit) {
          return;
        }
        logger.info("workspace-commit-after-timeout", {
          sessionID: sessionId,
          boardId: commit.boardId,
          seq: commit.lastSeq,
        });
        // Legacy full-snapshot fan-out; Phase 3 replaces this with the hub
        // replaying sequenced deltas off the store's commit point.
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
  // No raw opencode event fan-out. Agent events reach clients as sequenced
  // Chorus events through the store, so external payload shapes never appear on
  // the wire (spec §2 rule 5).
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
    .then((commit) => {
      if (!commit) {
        return;
      }

      logger.info("workspace-commit", {
        sessionID: event.sessionID,
        boardId: commit.boardId,
        seq: commit.lastSeq,
        events: commit.events.map((entry) => entry.type),
      });
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
  .use(createHttpRoutes(bridge, boardTasks))
  .use(createProjectRoutes(projectService))
  .use(createWorkspaceRoutes(workspaceStore))
  .use(voiceRoutes)
  .use(createWsHandler(bridge, hub, boardTasks))
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

async function gracefulShutdown(signal: string): Promise<void> {
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
    // Order matters: stop intake first, then tear down state channels,
    // then children. Each step awaited so the bounded budget is honest
    // and later async flushes (snapshot/coalescer) slot in without
    // reordering.
    hub.close();
    bridge.stop();
    await app.server?.stop();
    // Order matters: stop intake, then tear down state channels, then flush
    // durable state, then children. store.close() drains the serial queue,
    // writes a final snapshot, and folds the WAL so a cold copy of chorus.db is
    // a complete backup.
    await workspaceStore.close();
    await processManager.stop();
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
