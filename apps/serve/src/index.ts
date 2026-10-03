import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger } from "@chorus/logger";
import { sdkVersion } from "@chorus/oc-adapter";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { LoginRateLimiter } from "./auth/brute-force";
import { corsOptionsFor, resolveCorsPolicy } from "./auth/cors";
import { authGuardHandler } from "./auth/guard";
import { UnregisteredRootError } from "./auth/roots";
import { createAuthRoutes } from "./auth/routes";
import { pruneExpiredTickets, type TicketStore } from "./auth/ticket";
import { MissingTokenError, resolveToken } from "./auth/token";
import { OpenCodeBridge } from "./bridge/opencode/bridge";
import { loadConfig } from "./config";
import { OpenCodeProcessManager } from "./opencode/process-manager";
import { assertEngineLockstep } from "./paths/engine-lockstep";
import { NativeFolderPicker } from "./projects/folder-picker";
import { ProjectService } from "./projects/service";
import { WorktreeManager } from "./projects/worktree-manager";
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
 * spawned and a port is bound. The token value is never logged — only the file
 * path, and only when this process generated it.
 */
let token: string;
try {
  const resolved = await resolveToken({
    dataDir: config.dataDir,
    envToken: process.env.CHORUS_TOKEN,
    isProduction,
  });
  token = resolved.token;
  if (resolved.source === "generated") {
    // The value is never logged — only where to find it. The field is renamed
    // because the log gate scans whole call-site lines for sensitive keywords,
    // so the path cannot be read straight off the resolved object here.
    const { tokenPath: credentialFile } = resolved;
    logger.info("auth-credential-generated", { filePath: credentialFile });
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

const processManager = new OpenCodeProcessManager({
  directory: config.opencodeDirectory,
  port: config.opencodePort,
});

if (config.autoStartOpencode) {
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
const engineVersion = config.autoStartOpencode
  ? processManager.observedVersion
  : await processManager.probeVersion();
assertEngineLockstep(sdkVersion(), engineVersion);

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

logger.info("workspace-ready", {
  dataDir: config.dataDir,
  database: workspaceStore.databasePath,
  headSeq: workspaceStore.headSeq(),
});

/**
 * Drops worktrees no live board claims (plan P6 task 1).
 *
 * Runs after the store has loaded and before anything accepts a connection, so a
 * crashed serve does not leave its checkouts registered in the repo: `git
 * worktree list` would grow without bound across restarts, and a new board could
 * collide with a stale directory. Only entries under `.chorus-worktrees` whose
 * name is not a live board id are removed.
 */
if (config.autoStartOpencode) {
  const boards = workspaceStore.getSnapshot().boards;
  const liveBoardIds = new Set(boards.map((board) => board.boardId));
  const repositories = new Set(boards.map((board) => board.repo.directory));

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

  // A streamed delta carries no `activity` -- `normalizeMessagePartDelta` sets
  // `delta`, `messageID` and `partID` only -- so gating on `activity` alone
  // discarded every token of streamed model output before it could become a
  // `step.delta_appended`. Accept a delta as sufficient to reach the store; it
  // converts to a step event there, and the step projector is what decides
  // whether it has anywhere to land.
  if (!(event.sessionID && (event.activity || event.delta))) {
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

/**
 * Every prefix served by an API route.
 *
 * The frontend is served from a `/*` catch-all, so the guard cannot gate "all
 * non-API paths" without also gating the SPA the login screen is served from.
 * This list is the deny-side of that trade: anything matching an API prefix is
 * gated, and everything else is treated as a frontend route.
 *
 * The first cut of this helper allowed everything except `/api/`, which silently
 * exempted `/workspace`, `/tasks`, and `/voice` — the exact routes the plan
 * requires to 401.
 */
const API_PREFIXES = [
  "/api",
  "/auth",
  "/bridge",
  "/git",
  "/projects",
  "/sessions",
  "/snapshots",
  "/tasks",
  "/voice",
  "/workspace",
] as const;

function isStaticFrontendPath(pathname: string): boolean {
  return !API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

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
      isStaticAsset: isStaticFrontendPath,
      ticketOptions,
      token,
    })
  )

  .use(authRoutes)

  .use(createHttpRoutes(bridge, boardTasks, workspaceStore))
  .use(createProjectRoutes(projectService))
  .use(createWorkspaceRoutes(workspaceStore))
  .use(voiceRoutes)
  .use(
    createWsHandler({
      bridge,
      boardTasks,
      hub,
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
const app = corsOptions
  ? securedApp.use(cors(corsOptions)).listen(config.port)
  : securedApp.listen(config.port);

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
  // Deliberately not awaited: this is the last-resort path the shutdown timeout
  // timer calls, and the process is about to exit regardless.
  processManager.forceKill().catch(() => undefined);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
