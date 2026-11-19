import { mkdir } from "node:fs/promises";
import { createLogger } from "@chorus/logger";
import { resolveCorsPolicy } from "./auth/cors";
import { startLocalEntry } from "./auth/local-entry";
import { SessionRegistry } from "./auth/session-registry";
import { pruneExpiredTickets, type TicketStore } from "./auth/ticket";
import { MissingTokenError, resolveToken } from "./auth/token";
import { loadConfig } from "./config";
import { HostRemoteAccess } from "./hosting/remote-access";
import { ProjectEngineContext } from "./projects/engine-context";
import { NativeFolderPicker } from "./projects/folder-picker";
import { ProviderService } from "./projects/providers/service";
import { RepositoryRegistry } from "./projects/repository-registry";
import { ProjectService } from "./projects/service";
import { resolvePushConfiguration } from "./push/config";
import { PushDispatcher } from "./push/dispatcher";
import { createEngineRuntime } from "./server/bootstrap/engine-runtime";
import { createHttpApplication } from "./server/bootstrap/http-application";
import {
  createWorkspaceRuntime,
  pruneOrphanWorktrees,
} from "./server/bootstrap/workspace-runtime";
import { registerGracefulShutdown } from "./server/shutdown";
import { BoardTaskService } from "./tasks/board-task-service";
import { SessionWatchdog } from "./tasks/session-watchdog";
import { WorkspaceHub } from "./ws/hub";

const config = loadConfig();
const repositoryRegistry = await RepositoryRegistry.fromEnvironment(
  process.env.CHORUS_REPOSITORY_ROOTS
);
const isProduction = process.env.NODE_ENV === "production";
const logger = createLogger(
  {
    env: isProduction ? "production" : "development",
  },
  "SERVE"
);

await mkdir(config.dataDir, { recursive: true });

// Resolve the signing token before starting engines or listeners.
let token: string;
try {
  const resolved = await resolveToken({
    dataDir: config.dataDir,
    envToken: process.env.CHORUS_TOKEN,
    isProduction,
    managedLocalEntry: config.localEntryEnabled,
  });
  token = resolved.token;
  logger.info("auth-configured", { source: resolved.source });
} catch (error) {
  if (error instanceof MissingTokenError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const corsPolicy = resolveCorsPolicy({
  corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
  isProduction,
});
const { bridge, engineAuth, engineRegistry, processManager } =
  await createEngineRuntime(config);
const { workspaceStore, worktrees } = await createWorkspaceRuntime({
  bridge,
  config,
  isProduction,
  logger,
  repositoryRegistry,
});

const pushConfiguration = await resolvePushConfiguration(
  {
    enabled: config.pushEnabled,
    privateKey: config.vapidPrivateKey,
    publicKey: config.vapidPublicKey,
    subject: config.vapidSubject,
  },
  workspaceStore
);

await pruneOrphanWorktrees({
  repositoryRegistry,
  workspaceStore,
  worktrees,
  logger,
});

const ticketStore: TicketStore = workspaceStore.meta;
const sessionRegistry = new SessionRegistry(ticketStore, token);
sessionRegistry.prune();

const remoteAccess = await HostRemoteAccess.open({
  installationFile: process.env.CHORUS_RELAY_INSTALLATION,
  dataDir: config.dataDir,
  servePort: config.port,
  isProduction,
});

const hub = new WorkspaceHub(workspaceStore, {
  isDeviceAllowed: (deviceId) => sessionRegistry.deviceAllowed(deviceId),
  coalesceMs: config.coalesceMs,
});

const pushDispatcher = new PushDispatcher({
  isDeviceAllowed: (deviceId) => sessionRegistry.deviceAllowed(deviceId),
  allowedHosts: config.pushAllowedHosts,
  configuration: pushConfiguration,
  presence: hub,
  store: workspaceStore,
});
pushDispatcher.start();

pruneExpiredTickets(ticketStore);

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
  watchdog,
  repositoryRegistry
);
const projectEngineContext = new ProjectEngineContext({
  auth: engineAuth,
  baseUrl: config.opencodeBaseUrl,
  engineAdapterForDirectory: engineRegistry
    ? (directory) => engineRegistry.adapterForDirectory(directory)
    : undefined,
  prepareEngineDirectory: (directory) => bridge.subscribeDirectory(directory),
  repositoryRegistry,
});
const projectService = new ProjectService({
  defaultDirectory: config.opencodeDirectory,
  engine: projectEngineContext,
  folderPicker: new NativeFolderPicker(),
  registerPickedRepository: (directory) =>
    workspaceStore.registerPickedRepository(directory),
});
const providerService = new ProviderService({
  defaultDirectory: config.opencodeDirectory,
  engine: projectEngineContext,
});

let lastLoggedWorkspaceCommitSeq = 0;
bridge.subscribe(async (event) => {
  // Only sequenced Chorus events reach connected clients.
  if (event.type === "server.heartbeat") {
    return;
  }

  logger.debug("bridge-event", {
    type: event.type,
    ...(event.sessionID && { sessionID: event.sessionID }),
    ...(event.activity && { activity: event.activity }),
  });

  // Stream deltas have no activity field, so accept either activity or delta.
  if (!(event.sessionID && (event.activity || event.delta))) {
    return;
  }

  if (event.activity === "error" || event.activity === "idle") {
    watchdog.stop(event.sessionID);
  } else if (event.activity === "thinking" || event.activity === "writing") {
    const board = workspaceStore.getBoardBySessionId(event.sessionID);
    if (board?.session.currentTaskId) {
      watchdog.observeActivity(event.sessionID, {
        boardId: board.boardId,
        directory: board.repo.worktree ?? board.repo.directory,
      });
    } else {
      watchdog.reset(event.sessionID);
    }
  } else {
    watchdog.reset(event.sessionID);
  }

  const commit = await workspaceStore.applyAgentEvent(event);
  if (!commit) {
    return;
  }

  if (commit.lastSeq <= lastLoggedWorkspaceCommitSeq) {
    return;
  }
  lastLoggedWorkspaceCommitSeq = commit.lastSeq;

  logger.info("workspace-commit", {
    boardId: commit.boardId,
    seq: commit.lastSeq,
    events: commit.events.map((entry) => entry.type),
    ...(commit.boardId && event.sessionID
      ? { sessionID: event.sessionID }
      : {}),
  });
});

const app = createHttpApplication({
  boardTasks,
  bridge,
  config,
  corsPolicy,
  hub,
  isProduction,
  logger,
  projectService,
  providerService,
  pushConfiguration,
  remoteAccess,
  sessionRegistry,
  token,
  workspaceStore,
});

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

for (const board of workspaceStore.getSnapshot().boards) {
  const hasPendingApprovals = Object.values(board.columns)
    .flat()
    .some(
      (task) =>
        (task.pendingApprovals?.length ?? 0) > 0 ||
        task.pendingApproval !== undefined
    );
  if (
    !(
      board.session.sessionId &&
      (board.session.state === "active" || hasPendingApprovals)
    )
  ) {
    continue;
  }
  try {
    await bridge.subscribeDirectory(
      board.repo.worktree ?? board.repo.directory
    );
  } catch (error) {
    logger.warn("worktree-engine-restore-subscription-failed", {
      boardId: board.boardId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}

let localEntry: ReturnType<typeof startLocalEntry> | null = null;
try {
  if (config.localEntryEnabled) {
    localEntry = startLocalEntry({ token, registry: sessionRegistry });
  }
  app.listen({ hostname: config.bindAddress, port: config.port });
} catch (error) {
  pushDispatcher.stop();
  hub.close();
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
  closeWorkspaceHub: () => hub.close(),
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
