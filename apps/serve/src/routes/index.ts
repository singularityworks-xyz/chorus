import {
  boardAutocompleteRequestSchema,
  boardAutocompleteResponseSchema,
  boardSessionHistoryCommandSchema,
  queueBoardPromptInputSchema,
  sessionFileDiffsSchema,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import { ReferenceLookupError } from "@chorus/oc-adapter";
import { Elysia, t } from "elysia";
import { assertRegisteredRoot, UnregisteredRootError } from "../auth/roots";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import { EngineUnavailableError } from "../opencode/process-manager";
import { RepositoryRegistryError } from "../projects/repository-registry";
import { getDiff, getGitStatus, restore, track } from "../snapshot";
import { getRevertState } from "../snapshot/session-revert";
import type { BoardTaskService } from "../tasks/board-task-service";
import {
  BoardLifecycleError,
  BoardTaskCommandError,
  GlobalModelNotConfiguredError,
  SessionOwnershipError,
} from "../tasks/board-task-service";
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
const LEADING_SLASHES = /^\/+/;
const LEADING_DOT_SEGMENTS = /^(\.\/)+/;
const PATH_SEPARATORS = /[\\/]/;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

function boardTaskCommandStatus(error: BoardTaskCommandError): number {
  switch (error.code) {
    case "board_not_found":
    case "task_not_found":
      return 404;
    case "task_prompt_missing":
    case "task_review_invalid":
      return 422;
    case "prompt_dispatch_failed":
    case "session_command_failed":
      return 502;
    case "session_history_unavailable":
      return 503;
    default:
      return 409;
  }
}

function mapRouteError(error: unknown): {
  code: string;
  message: string;
  status: number;
} | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (error instanceof EngineUnavailableError) {
    return { code: error.code, message: error.message, status: 503 };
  }
  if (error instanceof ReferenceLookupError) {
    return {
      code: "autocomplete_unavailable",
      message:
        "Could not load board suggestions. Check the provider connection and retry.",
      status: 502,
    };
  }
  if (error instanceof UnknownSessionError) {
    return { code: "unknown_session", message: error.message, status: 404 };
  }
  if (error instanceof UnregisteredRootError) {
    return { code: "unregistered_root", message: error.message, status: 400 };
  }
  if (error instanceof RepositoryRegistryError) {
    return {
      code: error.code,
      message: error.message,
      status: error.code === "unregistered_repository_root" ? 403 : 400,
    };
  }
  if (error instanceof SessionOwnershipError) {
    return {
      code: error.code,
      message: error.message,
      status: error.code === "session_directory_unknown" ? 503 : 409,
    };
  }
  if (error instanceof BoardLifecycleError) {
    return {
      code: error.code,
      message: error.message,
      status: error.code === "board_abort_failed" ? 504 : 409,
    };
  }
  if (error instanceof GlobalModelNotConfiguredError) {
    return { code: error.code, message: error.message, status: 409 };
  }
  if (error instanceof BoardTaskCommandError) {
    return {
      code: error.code,
      message: error.message,
      status: boardTaskCommandStatus(error),
    };
  }
  return null;
}

/**
 * Validates a client-supplied `directory` against the boards the workspace
 * actually knows about (spec §6.4, plan P4.6).
 *
 * These routes hand `directory` to git as a working directory. Before this phase
 * nothing constrained it, so a caller could point `/snapshots/track` at an
 * arbitrary path on the host — and on the pre-P4 build these routes were also
 * unauthenticated.
 */
async function resolveBoardDirectory(
  store: WorkspaceStore,
  boardTasks: BoardTaskService,
  directory: string
): Promise<string> {
  const resolved = assertRegisteredRoot(directory, store.getSnapshot().boards);
  await boardTasks.assertCheckoutAuthorized(resolved);
  return resolved;
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
  const directoryFor = async (sessionID: string): Promise<string> => {
    const board = workspaceStore.getBoardBySessionId(sessionID);
    if (board) {
      boardTasks.assertBoardOpen(board.boardId);
    }
    const directory = resolveSessionDirectory(workspaceStore, sessionID);
    await boardTasks.assertCheckoutAuthorized(directory);
    return directory;
  };

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
        const mappedError = mapRouteError(error);
        if (!mappedError) {
          return undefined;
        }
        set.status = mappedError.status;
        return { code: mappedError.code, message: mappedError.message };
      })
      .get("/health", () => ({
        status: "ok",
        timestamp: Date.now(),
      }))

      .get("/bridge/status", () => bridge.getStatus())

      .get(
        "/boards/:boardID/autocomplete",
        async ({ params, query, set }) => {
          const parsed = boardAutocompleteRequestSchema.safeParse(query);
          if (!parsed.success) {
            set.status = 422;
            return {
              code: "invalid_autocomplete_request",
              message: "Choose a valid board suggestion lookup and try again.",
            };
          }

          const board = workspaceStore.getBoard(params.boardID);
          if (!board) {
            throw new BoardTaskCommandError(
              "board_not_found",
              "This board is no longer available. Reopen it and try again."
            );
          }

          boardTasks.assertBoardOpen(board.boardId);
          const directory = board.repo.worktree ?? board.repo.directory;
          await boardTasks.assertCheckoutAuthorized(directory);

          const request = parsed.data;
          switch (request.kind) {
            case "commands":
              return boardAutocompleteResponseSchema.parse({
                kind: request.kind,
                commands: await bridge.listAutocompleteCommands(directory),
              });
            case "skills":
              return boardAutocompleteResponseSchema.parse({
                kind: request.kind,
                skills: await bridge.listAutocompleteSkills(directory),
              });
            case "files":
              return boardAutocompleteResponseSchema.parse({
                kind: request.kind,
                files: (
                  await bridge.findAutocompleteFiles(request.query, directory)
                ).map((entry) => entry.path),
              });
            case "directory": {
              const relativePath = normalizeAutocompletePath(request.path);
              if (relativePath === null) {
                set.status = 422;
                return {
                  code: "invalid_autocomplete_path",
                  message: "Choose a folder inside this board and try again.",
                };
              }
              return boardAutocompleteResponseSchema.parse({
                kind: request.kind,
                entries: await bridge.listAutocompleteDirectory(
                  relativePath,
                  directory
                ),
              });
            }
            default:
              set.status = 422;
              return {
                code: "invalid_autocomplete_request",
                message:
                  "Choose a valid board suggestion lookup and try again.",
              };
          }
        },
        {
          params: t.Object({ boardID: t.String() }),
          query: t.Object({
            kind: t.Union([
              t.Literal("commands"),
              t.Literal("skills"),
              t.Literal("files"),
              t.Literal("directory"),
            ]),
            query: t.Optional(t.String({ maxLength: 256 })),
            path: t.Optional(t.String({ maxLength: 1024 })),
          }),
        }
      )

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
      )

      .post(
        "/tasks/:sessionID/approve",
        async ({ params, body }) => {
          const result = await bridge.replyPermission({
            directory: await directoryFor(params.sessionID),
            requestID: body.requestID,
            sessionID: params.sessionID,
            reply: "once",
            message: body.message,
          });
          if (result) {
            await workspaceStore.resolvePendingApproval(
              params.sessionID,
              body.requestID
            );
          }

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
            directory: await directoryFor(params.sessionID),
            requestID: body.requestID,
            sessionID: params.sessionID,
            reply: "reject",
            message: body.message,
          });
          if (result) {
            await workspaceStore.resolvePendingApproval(
              params.sessionID,
              body.requestID
            );
          }

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
          // The board's directory, then narrowed to this session.
          //
          // This passed the session id where a directory belongs, so the engine
          // was asked to list questions for a path called "sess-…" and returned
          // nothing. The engine lists per directory, so scoping by session is our
          // job.
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
        async ({ params, body }) => {
          await bridge.replyQuestion({
            directory: await directoryFor(params.sessionID),
            requestID: params.requestID,
            answers: body.answers,
          });
          await workspaceStore.resolvePendingApproval(
            params.sessionID,
            params.requestID
          );

          return {
            sessionID: params.sessionID,
            requestID: params.requestID,
            accepted: true,
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
            await directoryFor(params.sessionID)
          );
          await workspaceStore.resolvePendingApproval(
            params.sessionID,
            params.requestID
          );

          return {
            sessionID: params.sessionID,
            requestID: params.requestID,
            accepted: true,
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
      )
  );
}

/** Converts slash-triggered paths to board-relative paths and rejects escapes. */
function normalizeAutocompletePath(path: string): string | null {
  const relative = path
    .replace(LEADING_SLASHES, "")
    .replace(LEADING_DOT_SEGMENTS, "");
  if (
    path.startsWith("\\") ||
    WINDOWS_DRIVE_PREFIX.test(relative) ||
    relative.includes("\0") ||
    relative.split(PATH_SEPARATORS).some((segment) => segment === "..")
  ) {
    return null;
  }
  return relative || ".";
}
