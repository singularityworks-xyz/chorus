import type { QueueBoardPromptInput } from "@chorus/contracts";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import type { ServerWebSocket } from "bun";

export const WS_MESSAGE_TYPE = {
  TASK_QUEUE: "task.queue",
  TASK_APPROVE: "task.approve",
  TASK_REJECT: "task.reject",
  TASK_ABORT: "task.abort",
  TASK_REDIRECT: "task.redirect",
  TASK_QUESTION_REPLY: "task.question.reply",
  TASK_QUESTION_REJECT: "task.question.reject",
  VIEWPORT_SYNC: "viewport.sync",
  PRESENCE_PING: "presence.ping",
  AGENT_OUTPUT: "agent.output",
  MOBILE_PROMPT: "mobile.prompt",
  MOBILE_PROMPT_ACK: "mobile.prompt.ack",
} as const;

export const WS_RESPONSE_TYPE = {
  CONNECTED: "connected",
  ERROR: "error",
  TASK_QUEUED: "task.queued",
  TASK_APPROVED: "task.approved",
  TASK_REJECTED: "task.rejected",
  TASK_ABORTED: "task.aborted",
  TASK_REDIRECTED: "task.redirected",
  TASK_QUESTION_REPLIED: "task.question.replied",
  TASK_QUESTION_REJECTED: "task.question.rejected",
  PRESENCE_PONG: "presence.pong",
  UNKNOWN_MESSAGE: "unknown.message",
  AGENT_OUTPUT: "agent.output",
  MOBILE_PROMPT_RECEIVED: "mobile.prompt.received",
} as const;

export const SUPPORTED_MESSAGE_TYPES = [
  WS_MESSAGE_TYPE.TASK_QUEUE,
  WS_MESSAGE_TYPE.TASK_APPROVE,
  WS_MESSAGE_TYPE.TASK_REJECT,
  WS_MESSAGE_TYPE.TASK_ABORT,
  WS_MESSAGE_TYPE.TASK_REDIRECT,
  WS_MESSAGE_TYPE.TASK_QUESTION_REPLY,
  WS_MESSAGE_TYPE.TASK_QUESTION_REJECT,
  WS_MESSAGE_TYPE.VIEWPORT_SYNC,
  WS_MESSAGE_TYPE.PRESENCE_PING,
  WS_MESSAGE_TYPE.AGENT_OUTPUT,
  WS_MESSAGE_TYPE.MOBILE_PROMPT,
] as const;

export interface WsSession {
  id: string;
  ws: ServerWebSocket<WsContext>;
}

export interface WsContext {
  sessionId: string;
  subscriptions: Set<string>;
}

export type WsMessage =
  | { type: typeof WS_MESSAGE_TYPE.TASK_QUEUE; payload: QueueTaskPayload }
  | { type: typeof WS_MESSAGE_TYPE.TASK_APPROVE; payload: ApprovePayload }
  | { type: typeof WS_MESSAGE_TYPE.TASK_REJECT; payload: RejectPayload }
  | { type: typeof WS_MESSAGE_TYPE.TASK_ABORT; payload: AbortPayload }
  | { type: typeof WS_MESSAGE_TYPE.TASK_REDIRECT; payload: RedirectPayload }
  | {
      type: typeof WS_MESSAGE_TYPE.TASK_QUESTION_REPLY;
      payload: QuestionReplyPayload;
    }
  | {
      type: typeof WS_MESSAGE_TYPE.TASK_QUESTION_REJECT;
      payload: QuestionRejectPayload;
    }
  | { type: typeof WS_MESSAGE_TYPE.VIEWPORT_SYNC; payload: ViewportSyncPayload }
  | { type: typeof WS_MESSAGE_TYPE.PRESENCE_PING }
  | { type: typeof WS_MESSAGE_TYPE.AGENT_OUTPUT; payload: AgentOutputPayload }
  | {
      type: typeof WS_MESSAGE_TYPE.MOBILE_PROMPT;
      payload: MobilePromptPayload;
    };

export type QueueTaskPayload = QueueBoardPromptInput;

export interface ApprovePayload {
  message?: string;
  requestID: string;
  sessionID: string;
}

export interface RejectPayload {
  message?: string;
  requestID: string;
  sessionID: string;
}

export interface AbortPayload {
  sessionID: string;
}

export interface QuestionReplyPayload {
  answers: Array<{
    customAnswer?: string;
    optionIndices?: number[];
    questionIndex: number;
  }>;
  requestID: string;
  sessionID: string;
}

export interface QuestionRejectPayload {
  requestID: string;
  sessionID: string;
}

export interface RedirectPayload {
  mode: "soft" | "hard";
  sessionID: string;
  text: string;
}

export interface ViewportSyncPayload {
  projectId: string;
  viewport: { x: number; y: number; zoom: number };
}

export interface AgentOutputPayload {
  chunk: string;
  outputType: "log" | "error" | "result";
  sessionId: string;
  taskId: string;
  timestamp: number;
}

export interface MobilePromptPayload {
  promptId: string;
  sessionId: string;
  taskId: string;
  text: string;
}

export interface WsResponse<T = unknown> {
  payload: T;
  timestamp: number;
  type: string;
}

export function broadcast(
  clients: Set<ServerWebSocket<WsContext>>,
  event: NormalizedAgentEvent
): void {
  const message = JSON.stringify({
    type: `agent.${event.activity ?? event.type}`,
    payload: event,
    timestamp: Date.now(),
  } satisfies WsResponse<NormalizedAgentEvent>);

  for (const ws of clients) {
    ws.send(message);
  }
}

export function broadcastRaw(
  clients: Set<ServerWebSocket<WsContext>>,
  message: string
): void {
  for (const ws of clients) {
    ws.send(message);
  }
}

export function sendResponse<T>(
  ws: ServerWebSocket<WsContext>,
  type: string,
  payload: T
): void {
  ws.send(
    JSON.stringify({
      type,
      payload,
      timestamp: Date.now(),
    } satisfies WsResponse<T>)
  );
}
