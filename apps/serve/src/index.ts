import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger } from "@chorus/logger";
import { sdkVersion } from "@chorus/oc-adapter";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { LoginRateLimiter } from "./auth/brute-force";
import { corsOptionsFor, resolveCorsPolicy } from "./auth/cors";
import { createDeviceManagementRoutes } from "./auth/device-routes";
import { authGuardHandler, isPublicFrontendPath } from "./auth/guard";
import { startLocalEntry } from "./auth/local-entry";
import { DevicePairingTokenStore } from "./auth/pairing";
import { UnregisteredRootError } from "./auth/roots";
import { createAuthRoutes } from "./auth/routes";
import { SessionRegistry } from "./auth/session-registry";
import { pruneExpiredTickets, type TicketStore } from "./auth/ticket";
import { MissingTokenError, resolveToken } from "./auth/token";
import { OpenCodeBridge } from "./bridge/opencode/bridge";
import { loadConfig } from "./config";
import { HostRemoteAccess } from "./hosting/remote-access";
import { createRemoteAccessRoutes } from "./hosting/routes";
import { EngineRegistry } from "./opencode/engine-registry";
import {
  EngineUnavailableError,
  OpenCodeProcessManager,
} from "./opencode/process-manager";
import { assertEngineLockstep } from "./paths/engine-lockstep";
import { NativeFolderPicker } from "./projects/folder-picker";
import { RepositoryRegistry } from "./projects/repository-registry";
import { ProjectService } from "./projects/service";
import { WorktreeManager } from "./projects/worktree-manager";
import { resolvePushConfiguration } from "./push/config";
import { PushDispatcher } from "./push/dispatcher";
import { createPushRoutes } from "./push/routes";
import { createHttpRoutes } from "./routes";
import { createProjectRoutes } from "./routes/projects";
import { voiceRoutes } from "./routes/voice";
import { createWorkspaceRoutes } from "./routes/workspace";
import { applySecurityHeaders } from "./security-headers";
import { registerGracefulShutdown } from "./server/shutdown";
import { BoardTaskService } from "./tasks/board-task-service";
import { SessionWatchdog } from "./tasks/session-watchdog";
import { serveWebFrontend } from "./web-frontend";
import { WorkspaceStore } from "./workspace/store";
import { createWsHandler } from "./ws/handler";
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
const corsOptions = corsOptionsFor(corsPolicy);

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

// Check the running engine version, including engines adopted from a remote URL.
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

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function legacySnapshotPaths(): string[] {
  return [
    path.join(homedir(), ".chorus", "workspace.json"),
    path.join(process.cwd(), ".chorus", "workspace.json"),
  ];
}

const worktrees = new WorktreeManager();

const workspaceStore = new WorkspaceStore(config.dataDir, {
  dbSizeCapMb: config.dbSizeCapMb,
  retentionDays: config.retentionDays,
  snapshotInterval: config.snapshotInterval,
  worktreeProvisioner: worktrees,
  repositoryRegistry,
  restorePersistedRepositoryRoots: !isProduction,
});

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

bridge.setRecoverySessionProvider((directory) =>
  workspaceStore
    .getSnapshot()
    .boards.filter(
      (board) =>
        (board.repo.worktree ?? board.repo.directory) === directory &&
        board.session.currentTaskId !== undefined &&
        (board.session.state === "active" ||
          Object.values(board.columns)
            .flat()
            .some(
              (task) =>
                (task.pendingApprovals?.length ?? 0) > 0 ||
                task.pendingApproval !== undefined
            ))
    )
    .flatMap((board) =>
      board.session.sessionId ? [board.session.sessionId] : []
    )
);

logger.info("workspace-ready", {
  dataDir: config.dataDir,
  database: workspaceStore.databasePath,
  headSeq: workspaceStore.headSeq(),
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

{
  const boards = workspaceStore.getSnapshot().boards;
  const liveBoardIds = new Set(boards.map((board) => board.boardId));
  const repositories = new Set([
    ...boards.map((board) => board.repo.directory),
    ...repositoryRegistry.roots,
  ]);

  for (const directory of repositories) {
    try {
      const removed = await worktrees.pruneOrphans(directory, liveBoardIds);
      if (removed.length > 0) {
        logger.info("worktree-orphans-pruned", {
          count: removed.length,
          repository: directory,
        });
      }
    } catch (error) {
      // A moved or invalid repository must not prevent server startup.
      logger.warn("worktree-prune-failed", {
        error: error instanceof Error ? error.message : String(error),
        repository: directory,
      });
    }
  }
}

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

const loginRateLimiter = new LoginRateLimiter();
const pairingTokenStore = new DevicePairingTokenStore();
const ticketOptions = { now: Date.now, store: ticketStore };

workspaceStore.onCommit((commit) => {
  hub.publish(commit);
});

const authRoutes = createAuthRoutes({
  sessionRegistry,
  isProduction,
  localOrigins: corsPolicy.allowedOrigins,
  onLogoutDevice: async (deviceId) => {
    hub.disconnectDevice(deviceId);
    await workspaceStore.deleteDevicePushSubscriptions(deviceId);
  },
  pairingTokenStore,
  rateLimiter: loginRateLimiter,
  ticketStore,
  token,
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
const projectService = new ProjectService(
  config.opencodeBaseUrl,
  config.opencodeDirectory,
  new NativeFolderPicker(),
  (directory) => workspaceStore.registerPickedRepository(directory),
  config.opencodeUsername && config.opencodePassword
    ? {
        password: config.opencodePassword,
        username: config.opencodeUsername,
      }
    : undefined,
  repositoryRegistry,
  engineRegistry
    ? (directory) => engineRegistry.adapterForDirectory(directory)
    : undefined,
  (directory) => bridge.subscribeDirectory(directory)
);

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

const securedApp = new Elysia()
  // Apply headers before routing, including authentication short-circuits.
  .onRequest(({ set }) => {
    applySecurityHeaders(set.headers);
  })

  .onStart(() => {
    logger.info("server-starting", { port: config.port });
  })
  .onError(({ error, code, set }) => {
    if (error instanceof EngineUnavailableError) {
      set.status = 503;
      return { code: error.code, message: error.message };
    }
    if (error instanceof UnregisteredRootError) {
      set.status = 403;
      return { code: "unregistered_directory", message: error.message };
    }

    logger.error(
      `server-error: ${code}`,
      error instanceof Error ? error : undefined
    );
  })
  // Keep the frontend reachable so users can enter their token.
  .get("/", () => serveWebFrontend("/"))
  .get("/*", ({ request }) => {
    const url = new URL(request.url);
    return serveWebFrontend(url.pathname);
  })
  // Register the guard before route plugins so nested routes inherit it.
  .resolve(
    { as: "global" },
    authGuardHandler({
      sessionRegistry,
      isStaticAsset: isPublicFrontendPath,
      ticketOptions,
      token,
    })
  )

  .use(authRoutes)
  .use(
    createRemoteAccessRoutes({
      token,
      registry: sessionRegistry,
      remote: remoteAccess,
    })
  )
  .use(
    createDeviceManagementRoutes({
      token,
      registry: sessionRegistry,
      onRevoke: async (deviceId) => {
        hub.disconnectDevice(deviceId);
        await workspaceStore.deleteDevicePushSubscriptions(deviceId);
      },
    })
  )
  .use(
    createPushRoutes({
      allowedHosts: config.pushAllowedHosts,
      configuration: pushConfiguration,
      store: workspaceStore,
      token,
    })
  )

  .use(createHttpRoutes(bridge, boardTasks, workspaceStore))
  .use(createProjectRoutes(projectService, isProduction))
  .use(createWorkspaceRoutes(workspaceStore, boardTasks))
  .use(voiceRoutes)
  .use(
    createWsHandler({
      sessionRegistry,
      hub,
      ticketOptions,
      token,
    })
  );

// Mount CORS only when an explicit development allowlist exists.
const app = corsOptions ? securedApp.use(cors(corsOptions)) : securedApp;

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
