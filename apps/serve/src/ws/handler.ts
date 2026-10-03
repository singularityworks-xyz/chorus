import {
  queueBoardPromptInputSchema,
  WS_CLOSE_UNAUTHORIZED,
} from "@chorus/contracts";
import { Elysia, t } from "elysia";
import { verifyRequestCredential } from "../auth/guard";
import type { TicketOptions } from "../auth/ticket";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import type { BoardTaskService } from "../tasks/board-task-service";
import { resolveSessionDirectory } from "../tasks/session-directory";
import type { WorkspaceStore } from "../workspace/store";
import type { HubSocket, WorkspaceHub } from "./hub";
import type { WsMessage } from "./types";
import {
  SUPPORTED_MESSAGE_TYPES,
  WS_MESSAGE_TYPE,
  WS_RESPONSE_TYPE,
} from "./types";

/**
 * Adapts Elysia's websocket context to the hub's transport interface.
 *
 * Two Elysia details make this more than a cast. It hands each handler a
 * different wrapper object for the same connection, so the socket has to be
 * identified by `ctx.id` — comparing objects silently misses every lookup. And
 * it does not expose `getBufferedAmount` on the context at all, only on
 * `ctx.raw`.
 */
function toHubSocket(ctx: unknown): HubSocket {
  const elysiaCtx = ctx as {
    id?: string;
    raw?: { getBufferedAmount?: () => number };
    send: (data: string) => unknown;
  };

  const raw = elysiaCtx.raw;

  return {
    id: elysiaCtx.id ?? "",
    ...(typeof raw?.getBufferedAmount === "function"
      ? { getBufferedAmount: () => raw.getBufferedAmount?.() ?? 0 }
      : {}),
    send: (data: string) => elysiaCtx.send(data),
  };
}

/**
 * Message types the hub owns. These are the state-channel protocol (spec §4);
 * everything else in this file is a command the client sends over the socket
 * and the hub has no opinion about.
 *
 * Handing these to the hub first is what keeps a single emit path: the hub is
 * the only thing that ever writes to a client socket, including the legacy
 * command replies below.
 */
const HUB_OWNED_TYPES = new Set<string>([
  "hello",
  "pong",
  "resync",
  "viewport.sync",
]);

const WS_PAYLOAD_SCHEMAS = {
  [WS_MESSAGE_TYPE.TASK_QUEUE]: t.Any(),
  [WS_MESSAGE_TYPE.TASK_APPROVE]: t.Object({
    requestID: t.String(),
    sessionID: t.String(),
    message: t.Optional(t.String()),
  }),
  [WS_MESSAGE_TYPE.TASK_REJECT]: t.Object({
    requestID: t.String(),
    sessionID: t.String(),
    message: t.Optional(t.String()),
  }),
  [WS_MESSAGE_TYPE.TASK_ABORT]: t.Object({
    sessionID: t.String(),
  }),
  [WS_MESSAGE_TYPE.TASK_REDIRECT]: t.Object({
    sessionID: t.String(),
    text: t.String(),
    mode: t.Union([t.Literal("soft"), t.Literal("hard")]),
  }),
  [WS_MESSAGE_TYPE.TASK_QUESTION_REPLY]: t.Object({
    requestID: t.String(),
    sessionID: t.String(),
    answers: t.Array(
      t.Object({
        questionIndex: t.Number(),
        optionIndices: t.Optional(t.Array(t.Number())),
        customAnswer: t.Optional(t.String()),
      })
    ),
  }),
  [WS_MESSAGE_TYPE.TASK_QUESTION_REJECT]: t.Object({
    requestID: t.String(),
    sessionID: t.String(),
  }),
  [WS_MESSAGE_TYPE.VIEWPORT_SYNC]: t.Object({
    projectId: t.String(),
    viewport: t.Object({
      x: t.Number(),
      y: t.Number(),
      zoom: t.Number(),
    }),
  }),
  [WS_MESSAGE_TYPE.AGENT_OUTPUT]: t.Object({
    taskId: t.String(),
    sessionId: t.String(),
    chunk: t.String(),
    outputType: t.Union([
      t.Literal("log"),
      t.Literal("error"),
      t.Literal("result"),
    ]),
    timestamp: t.Number(),
  }),
  [WS_MESSAGE_TYPE.MOBILE_PROMPT]: t.Object({
    promptId: t.String(),
    taskId: t.String(),
    sessionId: t.String(),
    text: t.String(),
  }),
} as const;

export interface WsHandlerOptions {
  boardTasks: BoardTaskService;
  bridge: OpenCodeBridge;
  hub: WorkspaceHub;
  /** Cookie/ticket verification for the upgrade (spec §6.2). */
  ticketOptions: TicketOptions;
  token: string;
  /**
   * Read-only access to boards, to resolve the checkout a session belongs to.
   *
   * Command frames carry a session id, not a board, and the engine needs the
   * board's directory or the command lands in whatever directory serve was
   * started in.
   */
  workspaceStore: WorkspaceStore;
}

export function createWsHandler(options: WsHandlerOptions) {
  const { bridge, boardTasks, hub, workspaceStore, ticketOptions, token } =
    options;

  /**
   * Authenticates the upgrade.
   *
   * Elysia cannot reject a handshake from `.ws({ upgrade })` — the return value
   * is discarded — so an unauthenticated socket would be accepted and simply
   * closed afterwards. That still delivers the documented 4401 signal the
   * browser needs (a failed handshake exposes no body to JS), and no
   * application data is ever written to an unauthenticated socket: `open`
   * returns before `hub.register`, so it is not in the registry and receives no
   * events, heartbeat, or replay.
   *
   * `ws.request` is undefined; the request lives on `ws.data.request`.
   */
  // The credential verify is an async HMAC check, and the socket must not be
  // registered before it resolves.
  // biome-ignore lint/suspicious/useAwait: awaits the credential verify
  const authorizeUpgrade = async (
    ws: unknown
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const data = (ws as { data?: { request?: Request } }).data;
    if (!data?.request) {
      return { ok: false, reason: "no upgrade request" };
    }

    return verifyRequestCredential(data.request, { ticketOptions, token });
  };
  return new Elysia().ws("/ws", {
    // Transport shape only: "an object with a string type, and optionally a
    // payload or a resume cursor".
    //
    // Elysia's `t.Object` rejects unknown keys, so this has to enumerate the
    // fields the state-channel protocol actually uses — a schema of just
    // `{type, payload}` silently rejects every `hello`, because `since` is an
    // unexpected property, and the client receives a `validation` frame instead
    // of a snapshot. Protocol validation belongs to the contracts schemas the
    // hub applies; this only has to stop the transport from mangling frames on
    // the way in.
    body: t.Object({
      type: t.String(),
      payload: t.Optional(t.Any()),
      since: t.Optional(t.Number()),
    }),

    async open(ws) {
      const auth = await authorizeUpgrade(ws);
      if (!auth.ok) {
        console.warn("[ws] upgrade rejected:", auth.reason);
        ws.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
        return;
      }

      hub.register(toHubSocket(ws));
    },

    message(ws, message) {
      // Elysia has already parsed and validated the frame against `body`, so the
      // hub gets the re-serialized form. It re-validates with the contracts
      // schemas, which is deliberate: the transport shape and the protocol shape
      // are allowed to disagree, and the protocol wins.
      const rawMessage = JSON.stringify(message);

      // State-channel traffic goes to the hub and nothing else touches the
      // socket. Command replies go through the same socket but are produced
      // here, because the hub has no knowledge of task commands.
      if (rawTypeIs(rawMessage)) {
        hub
          .handleRawMessage(toHubSocket(ws), rawMessage)
          .catch((error: unknown) => {
            console.error("[ws] hub message error:", error);
          });
        return;
      }

      handleCommand(
        ws,
        message,
        bridge,
        boardTasks,
        workspaceStore,
        hub.clientCount(),
        hub.reply.bind(hub)
      ).catch((error: unknown) => {
        console.error("[ws] handler error:", error);
        hub.reply(ws, {
          payload: {
            message: error instanceof Error ? error.message : "unknown error",
          },
          timestamp: Date.now(),
          type: WS_RESPONSE_TYPE.ERROR,
        });
      });
    },

    close(ws) {
      hub.unregister(toHubSocket(ws));
    },

    drain() {
      // The hub samples getBufferedAmount() on its own before each send, so a
      // drain event needs no bookkeeping here — see the spike findings quoted
      // at the top of ws/hub.ts.
    },
  });
}

/** True when the hub, not the command handler, owns this frame. */
function rawTypeIs(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === "string" && HUB_OWNED_TYPES.has(parsed.type);
  } catch {
    // Unparseable input belongs to the hub so it can answer with a protocol
    // error rather than the command handler's unknown-message reply.
    return true;
  }
}

async function handleCommand(
  ws: unknown,
  message: { type: string; payload?: unknown },
  bridge: OpenCodeBridge,
  boardTasks: BoardTaskService,
  workspaceStore: WorkspaceStore,
  hubClientCount = 0,
  reply: (socket: HubSocket, payload: unknown) => boolean = (
    socket,
    payload
  ) => {
    (socket as { send: (data: string) => unknown }).send(
      JSON.stringify(payload)
    );
    return true;
  }
): Promise<void> {
  // Replies go through the hub so they are accounted like every other frame.
  // Writing straight to the socket made this a second, unthrottled write path:
  // a client too slow to drain control events kept receiving replies, and never
  // registered as congested.
  const wsSend = (payload: Record<string, unknown>) => {
    // A false result means the client disconnected before its reply arrived.
    // Nothing to do, and nothing to pretend about.
    reply(ws as HubSocket, payload);
  };

  /** The checkout a session belongs to; throws for a session we cannot place. */
  const directoryFor = (sessionID: string): string =>
    resolveSessionDirectory(workspaceStore, sessionID);

  /** Best-effort variant, for frames whose session id predates the board model. */
  const tryDirectoryFor = (sessionID: string): string | undefined => {
    try {
      return directoryFor(sessionID);
    } catch {
      return undefined;
    }
  };

  const msg = message as WsMessage;

  const validate = <T extends keyof typeof WS_PAYLOAD_SCHEMAS>(
    type: T,
    raw: unknown
  ) => {
    const schema = WS_PAYLOAD_SCHEMAS[type];
    if (!schema) {
      throw new Error(`No validation schema for message type: ${type}`);
    }
    return schema.Parse(raw);
  };

  switch (msg.type) {
    case WS_MESSAGE_TYPE.TASK_QUEUE: {
      validate(WS_MESSAGE_TYPE.TASK_QUEUE, msg.payload);
      const payload = queueBoardPromptInputSchema.parse(msg.payload);
      const response = await boardTasks.queuePrompt(payload);

      wsSend({
        type: WS_RESPONSE_TYPE.TASK_QUEUED,
        payload: response,
        timestamp: response.timestamp,
      });
      break;
    }

    case WS_MESSAGE_TYPE.TASK_APPROVE: {
      const payload = validate(WS_MESSAGE_TYPE.TASK_APPROVE, msg.payload);

      const result = await bridge.replyPermission({
        directory: directoryFor(payload.sessionID),
        requestID: payload.requestID,
        sessionID: payload.sessionID,
        reply: "once",
        message: payload.message,
      });

      wsSend({
        type: WS_RESPONSE_TYPE.TASK_APPROVED,
        payload: {
          requestID: payload.requestID,
          accepted: result,
        },
        timestamp: Date.now(),
      });
      break;
    }

    case WS_MESSAGE_TYPE.TASK_REJECT: {
      const payload = validate(WS_MESSAGE_TYPE.TASK_REJECT, msg.payload);

      const result = await bridge.replyPermission({
        directory: directoryFor(payload.sessionID),
        requestID: payload.requestID,
        sessionID: payload.sessionID,
        reply: "reject",
        message: payload.message,
      });

      wsSend({
        type: WS_RESPONSE_TYPE.TASK_REJECTED,
        payload: {
          requestID: payload.requestID,
          accepted: result,
        },
        timestamp: Date.now(),
      });
      break;
    }

    case WS_MESSAGE_TYPE.TASK_ABORT: {
      const payload = validate(WS_MESSAGE_TYPE.TASK_ABORT, msg.payload);

      const result = await bridge.abortSession(
        payload.sessionID,
        directoryFor(payload.sessionID)
      );

      wsSend({
        type: WS_RESPONSE_TYPE.TASK_ABORTED,
        payload: {
          sessionID: payload.sessionID,
          accepted: result,
        },
        timestamp: Date.now(),
      });
      break;
    }

    case WS_MESSAGE_TYPE.TASK_REDIRECT: {
      const payload = validate(WS_MESSAGE_TYPE.TASK_REDIRECT, msg.payload);

      if (payload.mode === "soft") {
        await bridge.promptSession({
          directory: directoryFor(payload.sessionID),
          sessionID: payload.sessionID,
          text: `Redirect instruction: ${payload.text}`,
        });

        wsSend({
          type: WS_RESPONSE_TYPE.TASK_REDIRECTED,
          payload: {
            sessionID: payload.sessionID,
            mode: payload.mode,
          },
          timestamp: Date.now(),
        });
        break;
      }

      const directory = directoryFor(payload.sessionID);

      const forked = await bridge.forkSession({
        sessionID: payload.sessionID,
        directory,
      });

      await bridge.promptSession({
        directory,
        sessionID: forked.id,
        text: payload.text,
      });

      wsSend({
        type: WS_RESPONSE_TYPE.TASK_REDIRECTED,
        payload: {
          originalSessionID: payload.sessionID,
          newSessionID: forked.id,
        },
        timestamp: Date.now(),
      });
      break;
    }

    case WS_MESSAGE_TYPE.TASK_QUESTION_REPLY: {
      const payload = validate(
        WS_MESSAGE_TYPE.TASK_QUESTION_REPLY,
        msg.payload
      );

      await bridge.replyQuestion({
        directory: directoryFor(payload.sessionID),
        requestID: payload.requestID,
        answers: payload.answers,
      });

      wsSend({
        type: WS_RESPONSE_TYPE.TASK_QUESTION_REPLIED,
        payload: {
          sessionID: payload.sessionID,
          requestID: payload.requestID,
        },
        timestamp: Date.now(),
      });
      break;
    }

    case WS_MESSAGE_TYPE.TASK_QUESTION_REJECT: {
      const payload = validate(
        WS_MESSAGE_TYPE.TASK_QUESTION_REJECT,
        msg.payload
      );

      await bridge.rejectQuestion(
        payload.requestID,
        directoryFor(payload.sessionID)
      );

      wsSend({
        type: WS_RESPONSE_TYPE.TASK_QUESTION_REJECTED,
        payload: {
          sessionID: payload.sessionID,
          requestID: payload.requestID,
        },
        timestamp: Date.now(),
      });
      break;
    }

    case WS_MESSAGE_TYPE.PRESENCE_PING: {
      wsSend({
        type: WS_RESPONSE_TYPE.PRESENCE_PONG,
        payload: {
          timestamp: Date.now(),
          clientCount: hubClientCount,
        },
        timestamp: Date.now(),
      });
      break;
    }

    case WS_MESSAGE_TYPE.AGENT_OUTPUT: {
      const payload = validate(WS_MESSAGE_TYPE.AGENT_OUTPUT, msg.payload);
      console.log(
        `[ws] agent output received for task ${payload.taskId}: ${payload.chunk.slice(0, 50)}...`
      );
      wsSend({
        type: WS_RESPONSE_TYPE.AGENT_OUTPUT,
        payload: {
          received: true,
          taskId: payload.taskId,
        },
        timestamp: Date.now(),
      });
      break;
    }

    case WS_MESSAGE_TYPE.MOBILE_PROMPT: {
      const payload = validate(WS_MESSAGE_TYPE.MOBILE_PROMPT, msg.payload);
      console.log(
        `[ws] mobile prompt received for task ${payload.taskId}: ${payload.text.slice(0, 50)}...`
      );

      try {
        await bridge.promptSession({
          // This frame carries a session id from a namespace older than the task
          // routes, so resolution is attempted and a miss falls back rather than
          // rejecting a legacy client.
          directory: tryDirectoryFor(payload.sessionId),
          sessionID: payload.sessionId,
          text: `[Mobile prompt] ${payload.text}`,
        });

        wsSend({
          type: WS_RESPONSE_TYPE.MOBILE_PROMPT_RECEIVED,
          payload: {
            promptId: payload.promptId,
            accepted: true,
          },
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error("[ws] failed to inject mobile prompt:", error);
        wsSend({
          type: WS_RESPONSE_TYPE.MOBILE_PROMPT_RECEIVED,
          payload: {
            promptId: payload.promptId,
            accepted: false,
            error: error instanceof Error ? error.message : "unknown error",
          },
          timestamp: Date.now(),
        });
      }
      break;
    }

    default: {
      const rawType = (message as { type: string }).type;
      wsSend({
        type: WS_RESPONSE_TYPE.UNKNOWN_MESSAGE,
        payload: {
          receivedType: rawType,
          supportedTypes: [...SUPPORTED_MESSAGE_TYPES],
        },
        timestamp: Date.now(),
      });
      break;
    }
  }
}
