import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger } from "@chorus/logger";
import { sdkVersion } from "@chorus/oc-adapter";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { LoginRateLimiter } from "./auth/brute-force";
import { corsOptionsFor, resolveCorsPolicy } from "./auth/cors";
import { authGuardHandler, isPublicFrontendPath } from "./auth/guard";
import { UnregisteredRootError } from "./auth/roots";
import { createAuthRoutes } from "./auth/routes";
import { pruneExpiredTickets, type TicketStore } from "./auth/ticket";
import { MissingTokenError, resolveToken } from "./auth/token";
import { OpenCodeBridge } from "./bridge/opencode/bridge";
import { loadConfig } from "./config";
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

/**
 * Token lifecycle (spec §6.1, decision #4).
 *
 * Resolved before anything is constructed so a production boot without
 * `CHORUS_TOKEN` fails immediately and loudly, rather than after the engine is
 * spawned and a port is bound. The token value is never logged. Local operators
 * get the credential file path on first boot and later restarts; an
 * environment-provided credential is identified without implying a file exists.
 */
let token: string;
try {
  const resolved = await resolveToken({
    dataDir: config.dataDir,
    envToken: process.env.CHORUS_TOKEN,
    isProduction,
  });
  token = resolved.token;
  if (resolved.source === "environment") {
    logger.info("auth-configured", { source: resolved.source });
  } else {
    // The value is never logged — only where to find it. Keep the sensitive
    // value out of the structured fields as well as the message.
    const { tokenPath: credentialFile } = resolved;
    logger.info("auth-credential-file", {
      filePath: credentialFile,
      source: resolved.source,
    });
  }
} catch (error) {
  if (error instanceof MissingTokenError) {
    // Actionable and specific, and it names the file the operator already has.
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
      directory: config.opencodeDirectory,
      port: config.opencodePort,
      username: config.opencodeUsername,
      password: config.opencodePassword,
      expectedVersion: sdkVersion(),
    });
const engineRegistry = config.opencodePerWorktree
  ? new EngineRegistry({
      expectedVersion: sdkVersion(),
      username: config.opencodeUsername,
      password: config.opencodePassword,
    })
  : null;

if (config.autoStartOpencode && processManager) {
  await processManager.start();
}

// SDK ↔ binary lockstep (pre-implementation decision #5).
//
// The adapter re-exports SDK event types, so an SDK that disagrees with the
// binary it is talking to produces type-level fiction and silently mis-normalized
// events — the failure mode recorded as known drift between 1.3.15 and 1.18.29.
// A boot-time mismatch is unrecoverable and must be loud rather than discovered
// later as missing cards.
//
// The binary side is what the engine reports, not what is on PATH: serve adopts
// an already-running engine when it finds one, and that one may not be the
// binary we would have spawned.
// Checked for an adopted engine too, not only one we spawned. An engine reached
// over `OPENCODE_BASE_URL` is exactly the case where the SDK and binary are most
// likely to have been upgraded independently, and `assertEngineLockstep` treats a
// version the engine does not report as a warning rather than a refusal.
//
// Probed without spawning when auto-start is off: serve must not start an engine
// the operator did not ask for, but it still needs to know what is serving.
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

/**
 * One manager for the process, injected here and reused for the boot prune.
 *
 * It has to be constructed and passed in: the store takes the provisioner by
 * injection, so a store built without one never creates a worktree at all and
 * every board silently shares the repo's primary checkout. Leaving this out is
 * how worktree-per-board shipped inert the first time — the tests that cover it
 * all build their own store, so none of them noticed.
 */
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

/**
 * Drops worktrees no live board claims (plan P6 task 1).
 *
 * Runs after the store has loaded and before anything accepts a connection, so a
 * crashed serve does not leave its checkouts registered in the repo: `git
 * worktree list` would grow without bound across restarts, and a new board could
 * collide with a stale directory. Only entries under `.chorus-worktrees` whose
 * name is not a live board id are removed.
 *
 * Not conditional on spawning an engine. Pruning is local git state, and gating it
 * on auto-start meant a serve pointed at a remote engine never cleaned up, so
 * stale worktrees accumulated and a new board could collide with one.
 */
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
      // A repository that cannot be inspected (moved, deleted, not a git repo)
      // must not stop serve from booting.
      logger.warn("worktree-prune-failed", {
        error: error instanceof Error ? error.message : String(error),
        repository: directory,
      });
    }
  }
}

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

const pushDispatcher = new PushDispatcher({
  allowedHosts: config.pushAllowedHosts,
  configuration: pushConfiguration,
  presence: hub,
  store: workspaceStore,
});
pushDispatcher.start();

/**
 * Ticket storage and the login limiter.
 *
 * The store is the ticket backend so a ticket issued before a restart still
 * works after one, and so the janitor has somewhere to run.
 */
const ticketStore: TicketStore = workspaceStore.meta;

pruneExpiredTickets(ticketStore);

const loginRateLimiter = new LoginRateLimiter();
const ticketOptions = { now: Date.now, store: ticketStore };

workspaceStore.onCommit((commit) => {
  hub.publish(commit);
});

const authRoutes = createAuthRoutes({
  isProduction,
  onLogoutDevice: async (deviceId) => {
    hub.disconnectDevice(deviceId);
    await workspaceStore.deleteDevicePushSubscriptions(deviceId);
  },
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

bridge.subscribe(async (event) => {
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
  });

  // A streamed delta carries no `activity` -- `normalizeMessagePartDelta` sets
  // `delta`, `messageID` and `partID` only -- so gating on `activity` alone
  // discarded every token of streamed model output before it could become a
  // `step.delta_appended`. Accept a delta as sufficient to reach the store; it
  // converts to a step event there, and the step projector is what decides
  // whether it has anywhere to land.
  if (!(event.sessionID && (event.activity || event.delta))) {
    return;
  }

  if (event.activity === "error") {
    watchdog.stop(event.sessionID);
  } else {
    watchdog.reset(event.sessionID);
  }

  const commit = await workspaceStore.applyAgentEvent(event);
  if (!commit) {
    return;
  }

  logger.info("workspace-commit", {
    sessionID: event.sessionID,
    boardId: commit.boardId,
    seq: commit.lastSeq,
    events: commit.events.map((entry) => entry.type),
  });
});

const securedApp = new Elysia()
  // Response headers are set in `onRequest` via `set.headers`, not `mapResponse`.
  //
  // `mapResponse` was the obvious choice and is wrong twice over here: it does not
  // propagate into `.use()`-ed route plugins at all, so every endpoint mounted as
  // a plugin came out bare — and on the paths where it *did* run, `response` was
  // `undefined` (it runs before the response is materialised) and casting it
  // turned every route into a 500. `onRequest` is the one hook that is
  // order-independent and reaches every route including a 401 short-circuit,
  // and `set.headers` merges into the final response.
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
    // A directory the workspace does not know about is a rejected request, not
    // a server fault. Surfacing it as 403 rather than 500 keeps the distinction
    // visible in logs and tells a client to fix its input rather than retry.
    if (error instanceof UnregisteredRootError) {
      set.status = 403;
      return { code: "unregistered_directory", message: error.message };
    }

    logger.error(
      `server-error: ${code}`,
      error instanceof Error ? error : undefined
    );
  })
  // Unauthenticated: the static frontend serves the login screen itself, so
  // gating it would leave an operator with a 401 and no way to present a token.
  .get("/", () => serveWebFrontend("/"))
  .get("/*", ({ request }) => {
    const url = new URL(request.url);
    return serveWebFrontend(url.pathname);
  })
  // Everything below here is gated.
  //
  // Registered inline on the main chain rather than wrapped in a `.use()`-ed
  // plugin: a hook that arrives via `.use()` does not propagate into the nested
  // route plugins, and the failure is silent. It must also precede the route
  // registrations below, because Elysia snapshots hooks when a route is added —
  // so `authRoutes` is mounted *after* the guard, not before. Login and logout
  // stay reachable through the guard's allowlist; `/auth/ws-ticket` does not,
  // which is why mounting order matters for it specifically.
  //
  // `auth-matrix.test.ts` asserts real 401s so a scoping regression fails there
  // instead of silently disabling the guard.
  .resolve(
    { as: "global" },
    authGuardHandler({
      isStaticAsset: isPublicFrontendPath,
      ticketOptions,
      token,
    })
  )

  .use(authRoutes)
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
      bridge,
      boardTasks,
      hub,
      workspaceStore,
      ticketOptions,
      token,
    })
  );

/**
 * CORS is mounted only when an explicit dev allowlist exists.
 *
 * In production the plugin is absent entirely: no origin is echoed and no
 * preflight succeeds, which is the strongest statement the browser understands
 * for "same-origin only". Mounting `@elysiajs/cors` with no options — the
 * previous state — reflects any `Origin` with credentials, which is no policy at
 * all.
 */
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

app.listen(config.port);

logger.info("server-running", {
  host: app.server?.hostname,
  port: app.server?.port,
  opencode: config.opencodeBaseUrl,
  directory: config.opencodeDirectory,
  ws: `ws://${app.server?.hostname}:${app.server?.port}/ws`,
});

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
    pushDispatcher.stop();
    hub.close();
    bridge.stop();
    await app.server?.stop();
    // Order matters: stop intake, then tear down state channels, then flush
    // durable state, then children. store.close() drains the serial queue,
    // writes a final snapshot, and folds the WAL so a cold copy of chorus.db is
    // a complete backup.
    await workspaceStore.close();
    await Promise.all([
      processManager?.stop() ?? Promise.resolve(),
      engineRegistry?.stop() ?? Promise.resolve(),
    ]);
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
  // Deliberately not awaited: this is the last-resort path the shutdown timeout
  // timer calls, and the process is about to exit regardless.
  processManager?.forceKill().catch(() => undefined);
  engineRegistry?.forceKill().catch(() => undefined);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
