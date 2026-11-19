import {
  boardSessionHistoryCommandSchema,
  queueBoardPromptInputSchema,
} from "@chorus/contracts";
import { Elysia, t } from "elysia";
import type { HttpRouteDependencies } from "../shared/dependencies";
export function createBoardTaskRoutes({ boardTasks }: HttpRouteDependencies) {
  return new Elysia()
    .post(
      "/tasks",
      ({ body, set }) => {
        const parsed = queueBoardPromptInputSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 422;
          return {
            code: "invalid_task_payload",
            issues: parsed.error.issues,
          };
        }

        // No broadcast here: the session write inside the task service commits
        // to the store, and the store's commit hook feeds the hub.
        return boardTasks.queuePrompt(parsed.data);
      },
      {
        body: t.Any(),
      }
    )

    .post(
      "/boards/:boardID/tasks/:taskID/run",
      ({ params }) => boardTasks.runQueuedTask(params.boardID, params.taskID),
      {
        params: t.Object({ boardID: t.String(), taskID: t.String() }),
      }
    )

    .post(
      "/boards/:boardID/tasks/:taskID/retry",
      ({ params }) => boardTasks.retryTask(params.boardID, params.taskID),
      {
        params: t.Object({ boardID: t.String(), taskID: t.String() }),
      }
    )

    .post(
      "/boards/:boardID/tasks/:taskID/abort",
      async ({ params }) => ({
        ...(await boardTasks.abortTask(params.boardID, params.taskID)),
        accepted: true,
      }),
      {
        params: t.Object({ boardID: t.String(), taskID: t.String() }),
      }
    )

    .post(
      "/boards/:boardID/tasks/:taskID/finalize-review",
      async ({ params, body }) => ({
        ...(await boardTasks.finalizeReview(
          params.boardID,
          params.taskID,
          body
        )),
        accepted: true,
      }),
      {
        params: t.Object({ boardID: t.String(), taskID: t.String() }),
        body: t.Object({
          plan: t.String(),
          answers: t.Optional(t.Array(t.String())),
        }),
      }
    )

    .post(
      "/boards/:boardID/tasks/:taskID/reject-review",
      ({ params }) => boardTasks.rejectReview(params.boardID, params.taskID),
      {
        params: t.Object({ boardID: t.String(), taskID: t.String() }),
      }
    )

    .get(
      "/boards/:boardID/session/history",
      ({ params }) => boardTasks.getSessionHistoryState(params.boardID),
      {
        params: t.Object({ boardID: t.String() }),
      }
    )

    .post(
      "/boards/:boardID/session/history/:command",
      ({ params, set }) => {
        const parsedCommand = boardSessionHistoryCommandSchema.safeParse(
          params.command
        );
        if (!parsedCommand.success) {
          set.status = 422;
          return {
            code: "invalid_session_history_command",
            message: "Choose either undo or redo.",
          };
        }
        return boardTasks.sessionHistoryCommand(
          params.boardID,
          parsedCommand.data
        );
      },
      {
        params: t.Object({
          boardID: t.String(),
          command: t.String(),
        }),
      }
    );
}
