import { createLogger } from "@chorus/logger";
import { Elysia, t } from "elysia";
import type { ProviderService } from "../projects/providers/service";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "SERVE:PROVIDER-ROUTES"
);

export function createProviderRoutes(providerService: ProviderService) {
  return new Elysia()
    .get(
      "/providers",
      ({ query }) => {
        logger.debug("route:providers", {
          directory: query.directory ?? null,
        });
        return query.directory
          ? providerService.listProvidersForDirectory(query.directory)
          : providerService.listProviders();
      },
      {
        query: t.Object({
          directory: t.Optional(t.String()),
        }),
      }
    )
    .get("/opencode/auth-credentials", () => {
      logger.debug("route:auth-credentials");
      return providerService.listCredentials();
    })
    .get("/opencode/configured-providers", () => {
      logger.debug("route:configured-providers");
      return providerService.listConfiguredProviders();
    })
    .get(
      "/models",
      ({ query }) => {
        logger.debug("route:models", {
          directory: query.directory ?? null,
        });
        return query.directory
          ? providerService.listModelsForDirectory(query.directory)
          : providerService.listModels();
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
        const configured = await providerService.configureProvider({
          directory: body.directory,
          providerID: body.providerID,
        });
        const catalog = await providerService.listConfiguredProviders();
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
        logger.info("route:open-models");
        return {
          opened: await providerService.openModels(body.directory),
        };
      },
      {
        body: t.Object({
          directory: t.Optional(t.String()),
        }),
      }
    )
    .post(
      "/opencode/connect",
      async ({ body }) => {
        logger.info("route:run-connect");
        return {
          opened: await providerService.runConnect(body.directory),
        };
      },
      {
        body: t.Object({
          directory: t.Optional(t.String()),
        }),
      }
    )
    .post(
      "/opencode/auth-login",
      async ({ body }) => {
        logger.info("route:auth-login");
        return {
          launched: await providerService.launchAuthLogin(body.directory),
        };
      },
      {
        body: t.Object({
          directory: t.Optional(t.String()),
        }),
      }
    );
}
