import { sessionFileDiffsSchema } from "@chorus/contracts";
import { Elysia, t } from "elysia";
import { getRevertState } from "../../snapshot/session-revert";
import {
  createSessionDirectoryResolver,
  type HttpRouteDependencies,
} from "../shared/dependencies";
import { routeLogger } from "../shared/logger";
export function createSessionRoutes({
  bridge,
  boardTasks,
  workspaceStore,
}: HttpRouteDependencies) {
  const directoryFor = createSessionDirectoryResolver(
    workspaceStore,
    boardTasks
  );
  const logger = routeLogger;
  return new Elysia()
    .post(
      "/sessions/:sessionID/revert",
      async ({ params }) => {
        const startTime = Date.now();
        try {
          logger.debug("Reverting session", { sessionID: params.sessionID });
          const result = await bridge.revertSession(
            params.sessionID,
            await directoryFor(params.sessionID)
          );
          const duration = Date.now() - startTime;
          logger.info("Session reverted", {
            sessionID: params.sessionID,
            messageID: result?.messageID,
            messageIndex: result?.messageIndex,
            totalMessages: result?.totalMessages,
            durationMs: duration,
          });
          return {
            success: true,
            messageID: result?.messageID,
            messageIndex: result?.messageIndex,
            totalMessages: result?.totalMessages,
            timestamp: Date.now(),
          };
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.error("Failed to revert session", error, {
            sessionID: params.sessionID,
            errorMessage,
            durationMs: duration,
          });
          throw error;
        }
      },
      {
        params: t.Object({
          sessionID: t.String(),
        }),
      }
    )

    .post(
      "/sessions/:sessionID/unrevert",
      async ({ params }) => {
        const startTime = Date.now();
        try {
          logger.debug("Unreverting session", {
            sessionID: params.sessionID,
          });
          await bridge.unrevertSession(
            params.sessionID,
            await directoryFor(params.sessionID)
          );
          const duration = Date.now() - startTime;
          logger.info("Session unreverted", {
            sessionID: params.sessionID,
            durationMs: duration,
          });
          return { success: true, timestamp: Date.now() };
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.error("Failed to unrevert session", error, {
            sessionID: params.sessionID,
            errorMessage,
            durationMs: duration,
          });
          throw error;
        }
      },
      {
        params: t.Object({
          sessionID: t.String(),
        }),
      }
    )

    .get(
      "/sessions/:sessionID/diff",
      async ({ params }) => {
        const directory = await directoryFor(params.sessionID);
        const diffs = await bridge.sessionDiff(params.sessionID, directory);
        return sessionFileDiffsSchema.parse(diffs);
      },
      {
        params: t.Object({ sessionID: t.String() }),
      }
    )

    .get(
      "/sessions/:sessionID/revert-state",
      ({ params }) => {
        const state = getRevertState(params.sessionID);
        return {
          hasRevertState: state != null,
          state: state ?? null,
          timestamp: Date.now(),
        };
      },
      {
        params: t.Object({
          sessionID: t.String(),
        }),
      }
    );
}
