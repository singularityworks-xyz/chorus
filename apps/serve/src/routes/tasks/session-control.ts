import { Elysia, t } from "elysia";
import { attachForkedSession } from "../../tasks/session-directory";
import type { HttpRouteDependencies } from "../shared/dependencies";
import { createSessionDirectoryResolver } from "../shared/dependencies";
import { pendingApprovalConflict } from "../shared/errors";
export function createSessionControlRoutes({
  bridge,
  boardTasks,
  workspaceStore,
}: HttpRouteDependencies) {
  const directoryFor = createSessionDirectoryResolver(
    workspaceStore,
    boardTasks
  );
  return new Elysia()
    .post(
      "/tasks/:sessionID/approve",
      async ({ params, body, set }) => {
        const directory = await directoryFor(params.sessionID);
        const result = await workspaceStore.runPendingApprovalAction(
          params.sessionID,
          body.requestID,
          () =>
            bridge.replyPermission({
              directory,
              requestID: body.requestID,
              sessionID: params.sessionID,
              reply: "once",
              message: body.message,
            }),
          { accepts: (accepted) => accepted, resume: true }
        );
        if (
          result.status === "already_resolving" ||
          result.status === "not_pending"
        ) {
          return pendingApprovalConflict(result.status, set);
        }

        return {
          sessionID: params.sessionID,
          requestID: body.requestID,
          accepted: result.status === "accepted",
          timestamp: Date.now(),
        };
      },
      {
        params: t.Object({
          sessionID: t.String(),
        }),
        body: t.Object({
          requestID: t.String(),
          message: t.Optional(t.String()),
        }),
      }
    )

    .post(
      "/tasks/:sessionID/reject",
      async ({ params, body, set }) => {
        const directory = await directoryFor(params.sessionID);
        const result = await workspaceStore.runPendingApprovalAction(
          params.sessionID,
          body.requestID,
          () =>
            bridge.replyPermission({
              directory,
              requestID: body.requestID,
              sessionID: params.sessionID,
              reply: "reject",
              message: body.message,
            }),
          { accepts: (accepted) => accepted }
        );
        if (
          result.status === "already_resolving" ||
          result.status === "not_pending"
        ) {
          return pendingApprovalConflict(result.status, set);
        }

        return {
          sessionID: params.sessionID,
          requestID: body.requestID,
          accepted: result.status === "accepted",
          timestamp: Date.now(),
        };
      },
      {
        params: t.Object({
          sessionID: t.String(),
        }),
        body: t.Object({
          requestID: t.String(),
          message: t.Optional(t.String()),
        }),
      }
    )

    .post(
      "/tasks/:sessionID/abort",
      async ({ params }) => {
        const board = workspaceStore.getBoardBySessionId(params.sessionID);
        if (!board) {
          await directoryFor(params.sessionID);
          return {
            sessionID: params.sessionID,
            accepted: false,
            timestamp: Date.now(),
          };
        }
        const taskId = board.session.currentTaskId;
        if (!taskId) {
          return {
            sessionID: params.sessionID,
            accepted: false,
            timestamp: Date.now(),
          };
        }
        const result = await boardTasks.abortTask(board.boardId, taskId);

        return {
          sessionID: params.sessionID,
          ...result,
          accepted: true,
          timestamp: Date.now(),
        };
      },
      {
        params: t.Object({
          sessionID: t.String(),
        }),
      }
    )

    .get(
      "/tasks/:sessionID/questions",
      async ({ params }) => {
        const questions = await bridge.listQuestions(
          await directoryFor(params.sessionID)
        );
        return {
          questions: questions.filter(
            (question) => question.sessionID === params.sessionID
          ),
          timestamp: Date.now(),
        };
      },
      {
        params: t.Object({
          sessionID: t.String(),
        }),
      }
    )

    .post(
      "/tasks/:sessionID/questions/:requestID/reply",
      async ({ params, body, set }) => {
        const directory = await directoryFor(params.sessionID);
        const result = await workspaceStore.runPendingApprovalAction(
          params.sessionID,
          params.requestID,
          () =>
            bridge.replyQuestion({
              directory,
              requestID: params.requestID,
              answers: body.answers,
            }),
          { resume: true }
        );
        if (
          result.status === "already_resolving" ||
          result.status === "not_pending"
        ) {
          return pendingApprovalConflict(result.status, set);
        }

        return {
          sessionID: params.sessionID,
          requestID: params.requestID,
          accepted: result.status === "accepted",
          timestamp: Date.now(),
        };
      },
      {
        params: t.Object({
          sessionID: t.String(),
          requestID: t.String(),
        }),
        body: t.Object({
          answers: t.Array(
            t.Object({
              questionIndex: t.Number(),
              optionIndices: t.Optional(t.Array(t.Number())),
              customAnswer: t.Optional(t.String()),
            })
          ),
        }),
      }
    )

    .post(
      "/tasks/:sessionID/questions/:requestID/reject",
      async ({ params, set }) => {
        const directory = await directoryFor(params.sessionID);
        const result = await workspaceStore.runPendingApprovalAction(
          params.sessionID,
          params.requestID,
          () => bridge.rejectQuestion(params.requestID, directory)
        );
        if (
          result.status === "already_resolving" ||
          result.status === "not_pending"
        ) {
          return pendingApprovalConflict(result.status, set);
        }

        return {
          sessionID: params.sessionID,
          requestID: params.requestID,
          accepted: result.status === "accepted",
          timestamp: Date.now(),
        };
      },
      {
        params: t.Object({
          sessionID: t.String(),
          requestID: t.String(),
        }),
      }
    )

    .post(
      "/tasks/:sessionID/redirect",
      async ({ params, body }) => {
        if (body.mode === "soft") {
          await bridge.promptSession({
            directory: await directoryFor(params.sessionID),
            sessionID: params.sessionID,
            text: `Redirect instruction: ${body.text}`,
          });

          return {
            sessionID: params.sessionID,
            mode: body.mode,
            timestamp: Date.now(),
          };
        }

        const directory = await directoryFor(params.sessionID);

        const forked = await bridge.forkSession({
          sessionID: params.sessionID,
          directory,
        });

        await attachForkedSession(workspaceStore, params.sessionID, forked.id);

        await bridge.promptSession({
          directory,
          sessionID: forked.id,
          text: body.text,
        });

        return {
          originalSessionID: params.sessionID,
          newSessionID: forked.id,
          mode: body.mode,
          timestamp: Date.now(),
        };
      },
      {
        params: t.Object({
          sessionID: t.String(),
        }),
        body: t.Object({
          text: t.String(),
          mode: t.Union([t.Literal("soft"), t.Literal("hard")]),
        }),
      }
    );
}
