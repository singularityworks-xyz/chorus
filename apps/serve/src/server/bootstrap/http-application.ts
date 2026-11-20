import type { Logger } from "@chorus/logger";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { LoginRateLimiter } from "../../auth/brute-force";
import { type CorsPolicy, corsOptionsFor } from "../../auth/cors";
import { createDeviceManagementRoutes } from "../../auth/device-routes";
import { authGuardHandler, isPublicFrontendPath } from "../../auth/guard";
import { DevicePairingTokenStore } from "../../auth/pairing";
import { UnregisteredRootError } from "../../auth/roots";
import { createAuthRoutes } from "../../auth/routes";
import type { SessionRegistry } from "../../auth/session-registry";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { ServerConfig } from "../../config";
import type { HostRemoteAccess } from "../../hosting/remote-access";
import { createRemoteAccessRoutes } from "../../hosting/routes";
import { EngineUnavailableError } from "../../opencode/process-manager/errors";
import type { ProviderService } from "../../projects/providers/service";
import type { ProjectService } from "../../projects/service";
import type { PushConfiguration } from "../../push/config";
import { createPushRoutes } from "../../push/routes";
import { createHttpRoutes } from "../../routes";
import { createProjectRoutes } from "../../routes/projects";
import { createProviderRoutes } from "../../routes/providers";
import { mapRepositoryRegistryError } from "../../routes/shared/repository-errors";
import { voiceRoutes } from "../../routes/voice";
import { createWorkspaceRoutes } from "../../routes/workspace";
import { applySecurityHeaders } from "../../security-headers";
import type { BoardTaskService } from "../../tasks/board-task-service";
import { serveWebFrontend } from "../../web-frontend";
import type { WorkspaceStore } from "../../workspace/store";
import { createWsHandler } from "../../ws/handler";
import type { WorkspaceHub } from "../../ws/hub";

export function createHttpApplication({
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
}: {
  boardTasks: BoardTaskService;
  bridge: OpenCodeBridge;
  config: ServerConfig;
  corsPolicy: CorsPolicy;
  hub: WorkspaceHub;
  isProduction: boolean;
  logger: Logger;
  projectService: ProjectService;
  providerService: ProviderService;
  pushConfiguration: PushConfiguration;
  remoteAccess: HostRemoteAccess;
  sessionRegistry: SessionRegistry;
  token: string;
  workspaceStore: WorkspaceStore;
}) {
  const ticketStore = workspaceStore.meta;
  const ticketOptions = { now: Date.now, store: ticketStore };

  const authRoutes = createAuthRoutes({
    sessionRegistry,
    isProduction,
    localOrigins: corsPolicy.allowedOrigins,
    onLogoutDevice: async (deviceId) => {
      hub.disconnectDevice(deviceId);
      await workspaceStore.deleteDevicePushSubscriptions(deviceId);
    },
    pairingTokenStore: new DevicePairingTokenStore(),
    rateLimiter: new LoginRateLimiter(),
    ticketStore,
    token,
  });

  const securedApp = new Elysia()
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
      const repositoryError = mapRepositoryRegistryError(error);
      if (repositoryError) {
        set.status = repositoryError.status;
        return {
          code: repositoryError.code,
          message: repositoryError.message,
        };
      }

      logger.error(
        `server-error: ${code}`,
        error instanceof Error ? error : undefined
      );
    })
    .get("/", () => serveWebFrontend("/"))
    .get("/*", ({ request }) => {
      const url = new URL(request.url);
      return serveWebFrontend(url.pathname);
    })
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
    .use(createProviderRoutes(providerService))
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

  const corsOptions = corsOptionsFor(corsPolicy);
  return corsOptions ? securedApp.use(cors(corsOptions)) : securedApp;
}
