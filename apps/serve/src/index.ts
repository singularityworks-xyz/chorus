import { mkdir } from "node:fs/promises";
import { createLogger } from "@chorus/logger";
import { resolveCorsPolicy } from "./auth/cors";
import { SessionRegistry } from "./auth/session-registry";
import { pruneExpiredTickets, type TicketStore } from "./auth/ticket";
import { MissingTokenError, resolveToken } from "./auth/token";
import { loadConfig } from "./config";
import { HostRemoteAccess } from "./hosting/remote-access";
import { RepositoryRegistry } from "./projects/repository-registry";
import { resolvePushConfiguration } from "./push/config";
import { PushDispatcher } from "./push/dispatcher";
import { subscribeToAgentEvents } from "./server/bootstrap/agent-events";
import { createEngineRuntime } from "./server/bootstrap/engine-runtime";
import { createHttpApplication } from "./server/bootstrap/http-application";
import { startServeServer } from "./server/bootstrap/start-server";
import { createTaskRuntime } from "./server/bootstrap/task-runtime";
import {
  createWorkspaceRuntime,
  pruneOrphanWorktrees,
} from "./server/bootstrap/workspace-runtime";
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

const taskRuntime = createTaskRuntime({
  bridge,
  config,
  engineAuth,
  engineRegistry,
  logger,
  repositoryRegistry,
  workspaceStore,
});
const { boardTasks, projectService, providerService, watchdog } = taskRuntime;
subscribeToAgentEvents({ bridge, logger, watchdog, workspaceStore });

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

await startServeServer({
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
  workspaceHub: hub,
  workspaceStore,
});
