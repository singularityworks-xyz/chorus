import { createLogger } from "@chorus/logger";
import { Elysia, t } from "elysia";
import { FolderPickerUnavailableError } from "../projects/folder-picker";
import { RepositoryRegistryError } from "../projects/repository-registry";
import type { ProjectService } from "../projects/service";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "SERVE:PROJECT-ROUTES"
);

export function createProjectRoutes(
  projectService: ProjectService,
  isProduction = false
) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof RepositoryRegistryError) {
        set.status = error.code === "unregistered_repository_root" ? 403 : 400;
        return { code: error.code, message: error.message };
      }
      return undefined;
    })
    .get("/projects", () => {
      logger.debug("route:projects");
      return projectService.listProjects();
    })
    .get(
      "/providers",
      ({ query }) => {
        logger.debug("route:providers", {
          directory: query.directory ?? null,
        });
        return query.directory
          ? projectService.listProvidersForDirectory(query.directory)
          : projectService.listProviders();
      },
      {
        query: t.Object({
          directory: t.Optional(t.String()),
        }),
      }
    )
    .get("/opencode/auth-credentials", () => {
      logger.debug("route:auth-credentials");
      return projectService.listCredentials();
    })
    .get("/opencode/configured-providers", () => {
      logger.debug("route:configured-providers");
      return projectService.listConfiguredProviders();
    })
    .get(
      "/models",
      ({ query }) => {
        logger.debug("route:models", {
          directory: query.directory ?? null,
        });
        return query.directory
          ? projectService.listModelsForDirectory(query.directory)
          : projectService.listModels();
      },
      {
        query: t.Object({
          directory: t.Optional(t.String()),
        }),
      }
    )
    .post(
      "/opencode/configure-provider",
      async ({ body }) => {
        logger.info("route:configure-provider", {
          directory: body.directory ?? null,
          providerID: body.providerID,
        });
        const configured = await projectService.configureProvider({
          directory: body.directory,
          providerID: body.providerID,
        });
        const catalog = await projectService.listConfiguredProviders();
        return {
          configured,
          providerIDs: catalog.providerIDs,
        };
      },
      {
        body: t.Object({
          directory: t.Optional(t.String()),
          providerID: t.String(),
        }),
      }
    )
    .post(
      "/opencode/models",
      async ({ body }) => {
        logger.info("route:open-models", {
          directory: body.directory,
        });
        return {
          opened: await projectService.openModels(body.directory),
        };
      },
      {
        body: t.Object({
          directory: t.String(),
        }),
      }
    )
    .post(
      "/opencode/connect",
      async ({ body }) => {
        logger.info("route:run-connect", {
          directory: body.directory,
        });
        return {
          opened: await projectService.runConnect(body.directory),
        };
      },
      {
        body: t.Object({
          directory: t.String(),
        }),
      }
    )
    .post(
      "/opencode/auth-login",
      async ({ body }) => {
        logger.info("route:auth-login", {
          directory: body.directory,
        });
        return {
          launched: await projectService.launchAuthLogin(body.directory),
        };
      },
      {
        body: t.Object({
          directory: t.String(),
        }),
      }
    )
    .post("/projects/open-folder", async ({ set }) => {
      if (isProduction) {
        set.status = 503;
        return {
          code: "host_folder_picker_disabled",
          message:
            "Configure CHORUS_REPOSITORY_ROOTS to add repositories on this server",
        };
      }
      try {
        return await projectService.openFolder();
      } catch (error) {
        if (error instanceof FolderPickerUnavailableError) {
          set.status = 503;
          return {
            code: "folder_picker_unavailable",
            message: error.message,
          };
        }

        throw error;
      }
    });
}
