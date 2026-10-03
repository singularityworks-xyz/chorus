import { queueBoardPromptInputSchema } from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import { Elysia, t } from "elysia";
import { assertRegisteredRoot, UnregisteredRootError } from "../auth/roots";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import { getDiff, getGitStatus, restore, track } from "../snapshot";
import { getRevertState } from "../snapshot/session-revert";
import type { BoardTaskService } from "../tasks/board-task-service";
import {
  attachForkedSession,
  resolveSessionDirectory,
  UnknownSessionError,
} from "../tasks/session-directory";
import type { WorkspaceStore } from "../workspace/store";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "ROUTES"
);

/**
 * Validates a client-supplied `directory` against the boards the workspace
 * actually knows about (spec §6.4, plan P4.6).
 *
 * These routes hand `directory` to git as a working directory. Before this phase
 * nothing constrained it, so a caller could point `/snapshots/track` at an
 * arbitrary path on the host — and on the pre-P4 build these routes were also
 * unauthenticated.
 */
function resolveBoardDirectory(
  store: WorkspaceStore,
  directory: string
): string {
  return assertRegisteredRoot(directory, store.getSnapshot().boards);
}

export function createHttpRoutes(
  bridge: OpenCodeBridge,
  boardTasks: BoardTaskService,
  workspaceStore: WorkspaceStore
) {
  /**
   * The checkout a session belongs to.
   *
   * Follow-up commands arrive with only a session id. Resolving the board here
   * rather than letting the bridge fall back to its default directory is what
   * keeps an approval or a redirect inside the board's own worktree — the
   * bridge's default is the directory serve was started in, which for a worktree
   * board is the wrong tree.
   *
   * Throws `UnknownSessionError`, which surfaces as a 4xx-ish failure rather than
   * a command silently applied in the wrong place.
   */
  const directoryFor = (sessionID: string): string =>
    resolveSessionDirectory(workspaceStore, sessionID);

  return (
    new Elysia()
      /**
       * Maps the guard errors to client statuses.
       *
       * Both are raised by request data, not by a fault: an unregistered root is a
       * bad request and an unresolvable session is a lookup miss. Letting them fall
       * through to the default turned every one into a 500, which reads as a server
       * fault and hides the actionable message from anything keying on status.
       */
      .onError(({ error, set }) => {
        if (error instanceof UnknownSessionError) {
          set.status = 404;
          return { code: "unknown_session", message: error.message };
        }

        if (error instanceof UnregisteredRootError) {
          set.status = 400;
          return { code: "unregistered_root", message: error.message };
        }

        return undefined;
      })
      .get("/health", () => ({
        status: "ok",
        timestamp: Date.now(),
      }))

      .get("/bridge/status", () => bridge.getStatus())

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
        "/tasks/:sessionID/approve",
        async ({ params, body }) => {
          const result = await bridge.replyPermission({
            directory: directoryFor(params.sessionID),
            requestID: body.requestID,
            sessionID: params.sessionID,
            reply: "once",
            message: body.message,
          });

          return {
            sessionID: params.sessionID,
            requestID: body.requestID,
            accepted: result,
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
        async ({ params, body }) => {
          const result = await bridge.replyPermission({
            directory: directoryFor(params.sessionID),
            requestID: body.requestID,
            sessionID: params.sessionID,
            reply: "reject",
            message: body.message,
          });

          return {
            sessionID: params.sessionID,
            requestID: body.requestID,
            accepted: result,
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
        "/tasks/:sessionID/finalize-review",
        async ({ params, body }) => {
          logger.info("finalize-review", {
            sessionID: params.sessionID,
            planPreview: body.plan?.slice(0, 100),
          });

          await bridge.promptSessionAsync({
            directory: directoryFor(params.sessionID),
            sessionID: params.sessionID,
            text: `The plan has been reviewed and finalized. Here is the final plan:\n\n${body.plan}\n\n${body.questions && body.questions.length > 0 ? `Answers to your questions:\n${body.questions.map((q: { question: string; answer: string }) => `- ${q.question}: ${q.answer}`).join("\n")}\n\n` : ""}Please proceed with implementing this plan.`,
          });

          return {
            sessionID: params.sessionID,
            accepted: true,
            timestamp: Date.now(),
          };
        },
        {
          params: t.Object({
            sessionID: t.String(),
          }),
          body: t.Object({
            plan: t.String(),
            questions: t.Optional(
              t.Array(
                t.Object({
                  question: t.String(),
                  answer: t.String(),
                })
              )
            ),
          }),
        }
      )

      .post(
        "/tasks/:sessionID/abort",
        async ({ params }) => {
          const result = await bridge.abortSession(
            params.sessionID,
            directoryFor(params.sessionID)
          );

          return {
            sessionID: params.sessionID,
            accepted: result,
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
          // The board's directory, then narrowed to this session.
          //
          // This passed the session id where a directory belongs, so the engine
          // was asked to list questions for a path called "sess-…" and returned
          // nothing. The engine lists per directory, so scoping by session is our
          // job.
          const questions = await bridge.listQuestions(
            directoryFor(params.sessionID)
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
        async ({ params, body }) => {
          await bridge.replyQuestion({
            directory: directoryFor(params.sessionID),
            requestID: params.requestID,
            answers: body.answers,
          });

          return {
            sessionID: params.sessionID,
            requestID: params.requestID,
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
        async ({ params }) => {
          await bridge.rejectQuestion(
            params.requestID,
            directoryFor(params.sessionID)
          );

          return {
            sessionID: params.sessionID,
            requestID: params.requestID,
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
              directory: directoryFor(params.sessionID),
              sessionID: params.sessionID,
              text: `Redirect instruction: ${body.text}`,
            });

            return {
              sessionID: params.sessionID,
              mode: body.mode,
              timestamp: Date.now(),
            };
          }

          const directory = directoryFor(params.sessionID);

          const forked = await bridge.forkSession({
            sessionID: params.sessionID,
            directory,
          });

          // Bind the fork to the board before prompting it.
          //
          // Follow-up commands resolve their directory from the board that owns
          // the session, so an unbound fork makes every later command for the new
          // session fail as unknown — and agent events for it have no board to
          // attach to. The fork *is* the board's session now.
          await attachForkedSession(
            workspaceStore,
            params.sessionID,
            forked.id
          );

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
      )

      .post(
        "/sessions/:sessionID/revert",
        async ({ params }) => {
          const startTime = Date.now();
          try {
            logger.debug("Reverting session", { sessionID: params.sessionID });
            const result = await bridge.revertSession(
              params.sessionID,
              directoryFor(params.sessionID)
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
              directoryFor(params.sessionID)
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

      .post(
        "/snapshots/track",
        async ({ body }) => {
          try {
            const hash = await track(
              resolveBoardDirectory(workspaceStore, body.directory)
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
              resolveBoardDirectory(workspaceStore, body.directory),
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
              resolveBoardDirectory(workspaceStore, query.directory),
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
      )

      .get(
        "/git/status",
        async ({ query }) => {
          try {
            const status = await getGitStatus(
              resolveBoardDirectory(workspaceStore, query.directory)
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
      )
  );
}
