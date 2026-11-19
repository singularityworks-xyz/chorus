import { Elysia, t } from "elysia";
import { getDiff, restore, track } from "../../snapshot";
import {
  type HttpRouteDependencies,
  resolveBoardDirectory,
} from "../shared/dependencies";
import { routeLogger } from "../shared/logger";
export function createSnapshotRoutes({
  boardTasks,
  workspaceStore,
}: HttpRouteDependencies) {
  const logger = routeLogger;
  return new Elysia()
    .post(
      "/snapshots/track",
      async ({ body }) => {
        try {
          const hash = await track(
            await resolveBoardDirectory(
              workspaceStore,
              boardTasks,
              body.directory
            )
          );
          return { hash, timestamp: Date.now() };
        } catch (error) {
          logger.error("Failed to track snapshot", error, {
            directory: body.directory,
          });
          throw error;
        }
      },
      {
        body: t.Object({
          directory: t.String(),
        }),
      }
    )

    .post(
      "/snapshots/restore",
      async ({ body }) => {
        try {
          await restore(
            await resolveBoardDirectory(
              workspaceStore,
              boardTasks,
              body.directory
            ),
            body.hash
          );
          return { success: true, timestamp: Date.now() };
        } catch (error) {
          logger.error("Failed to restore snapshot", error, {
            directory: body.directory,
            hash: body.hash,
          });
          throw error;
        }
      },
      {
        body: t.Object({
          directory: t.String(),
          hash: t.String(),
        }),
      }
    )

    .get(
      "/snapshots/diff",
      async ({ query }) => {
        try {
          const diff = await getDiff(
            await resolveBoardDirectory(
              workspaceStore,
              boardTasks,
              query.directory
            ),
            query.fromHash
          );
          return { diff, timestamp: Date.now() };
        } catch (error) {
          logger.error("Failed to get snapshot diff", error, {
            directory: query.directory,
            fromHash: query.fromHash,
          });
          throw error;
        }
      },
      {
        query: t.Object({
          directory: t.String(),
          fromHash: t.String(),
        }),
      }
    );
}
