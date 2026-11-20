import { Elysia, t } from "elysia";
import { getGitStatus } from "../../snapshot/status";
import {
  type HttpRouteDependencies,
  resolveBoardDirectory,
} from "../shared/dependencies";
import { routeLogger } from "../shared/logger";
export function createGitStatusRoutes({
  boardTasks,
  workspaceStore,
}: HttpRouteDependencies) {
  const logger = routeLogger;
  return new Elysia().get(
    "/git/status",
    async ({ query }) => {
      try {
        const status = await getGitStatus(
          await resolveBoardDirectory(
            workspaceStore,
            boardTasks,
            query.directory
          )
        );
        return { ...status, timestamp: Date.now() };
      } catch (error) {
        logger.error("Failed to get git status", error, {
          directory: query.directory,
        });
        throw error;
      }
    },
    {
      query: t.Object({
        directory: t.String(),
      }),
    }
  );
}
