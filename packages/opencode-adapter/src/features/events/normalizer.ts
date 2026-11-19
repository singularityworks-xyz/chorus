import type { Event as OCEvent } from "@opencode-ai/sdk/v2";
import { extractFileDiff } from "./normalizer/file-diff";
import {
  hasAssistantMessage,
  recordAssistantMessage,
} from "./normalizer/message-tracking";
import type {
  NormalizedActivity,
  NormalizedAgentEvent,
} from "./normalizer/types";

function normalizeMessagePartUpdated(
  base: NormalizedAgentEvent,
  raw: Extract<OCEvent, { type: "message.part.updated" }>,
  scope: string
): NormalizedAgentEvent {
  const part = raw.properties.part;
  const sessionID = raw.properties.sessionID;
  const messageID = part.messageID;

  if (!hasAssistantMessage(scope, sessionID, messageID)) {
    return { ...base, sessionID };
  }

  if (part.type === "text") {
    return {
      ...base,
      sessionID,
      activity: "writing",
      messageID,
      partID: part.id,
      partType: "text",
      text: part.text,
    };
  }
  if (part.type === "tool") {
    const state = part.state;
    const fileDiff = extractFileDiff(part.tool, state);
    return {
      ...base,
      sessionID,
      activity: state.status === "running" ? "thinking" : "writing",
      messageID,
      partID: part.id,
      partType: "tool",
      toolName: part.tool,
      toolState: state.status,
      fileDiff,
    };
  }
  if (part.type === "reasoning") {
    return {
      ...base,
      sessionID,
      activity: "thinking",
      messageID,
      partID: part.id,
      partType: "reasoning",
      text: part.text,
    };
  }
  return { ...base, sessionID };
}

function normalizeMessagePartDelta(
  base: NormalizedAgentEvent,
  raw: Extract<OCEvent, { type: "message.part.delta" }>,
  scope: string
): NormalizedAgentEvent {
  const props = raw.properties;
  const sessionID = props.sessionID;
  const messageID = props.messageID;

  if (!hasAssistantMessage(scope, sessionID, messageID)) {
    return { ...base, sessionID };
  }

  return {
    ...base,
    sessionID,
    messageID,
    partID: props.partID,
    delta: props.delta,
  };
}

function normalizeSessionStatus(
  base: NormalizedAgentEvent,
  raw: Extract<OCEvent, { type: "session.status" }>
): NormalizedAgentEvent {
  const status = raw.properties.status;
  let activity: NormalizedActivity = "idle";
  if (status.type === "busy") {
    activity = "thinking";
  }
  if (status.type === "retry") {
    activity = "thinking";
  }
  return {
    ...base,
    sessionID: raw.properties.sessionID,
    activity,
  };
}

function normalizeMessageUpdated(
  base: NormalizedAgentEvent,
  raw: Extract<OCEvent, { type: "message.updated" }>,
  scope: string
): NormalizedAgentEvent {
  const info = raw.properties.info;
  const sessionID = raw.properties.sessionID;
  const messageID = info.id;

  if (info.role === "assistant") {
    recordAssistantMessage(scope, sessionID, messageID);
  }

  if (info.role === "assistant" && "error" in info && info.error) {
    return {
      ...base,
      sessionID,
      messageID,
      activity: "error",
      error: String(info.error.data?.message ?? ""),
    };
  }
  return { ...base, sessionID, messageID };
}

export function normalizeEvent(
  raw: OCEvent,
  scope = "default"
): NormalizedAgentEvent {
  const base: NormalizedAgentEvent = {
    sourceEventId: sourceEventIdFor(raw),
    type: raw.type,
    timestamp: Date.now(),
  };

  switch (raw.type) {
    case "message.part.updated":
      return normalizeMessagePartUpdated(base, raw, scope);
    case "message.part.delta":
      return normalizeMessagePartDelta(base, raw, scope);
    case "session.status":
      return normalizeSessionStatus(base, raw);
    case "session.idle":
      return { ...base, sessionID: raw.properties.sessionID, activity: "idle" };
    case "permission.asked":
      return {
        ...base,
        sessionID: raw.properties.sessionID,
        activity: "waiting_for_approval",
        permissionID: raw.properties.id,
        permission: raw.properties.permission,
      };
    case "question.asked":
      return {
        ...base,
        sessionID: raw.properties.sessionID,
        activity: "waiting_for_question",
        questionID: raw.properties.id,
        questions: raw.properties.questions.map(
          (q: Record<string, unknown>) => ({
            question: String(q.question ?? ""),
            header: String(q.header ?? ""),
            options: ((q.options as Record<string, unknown>[]) ?? []).map(
              (o) => ({
                label: String(o.label ?? ""),
                description: String(o.description ?? ""),
              })
            ),
            multiple: q.multiple === true,
            custom: q.custom !== false,
          })
        ),
      };
    case "session.error":
      return {
        ...base,
        sessionID: raw.properties.sessionID,
        activity: "error",
        error: String(raw.properties.error?.data?.message ?? ""),
      };
    case "message.updated":
      return normalizeMessageUpdated(base, raw, scope);
    default:
      return base;
  }
}

function sourceEventIdFor(raw: OCEvent): string {
  switch (raw.type) {
    case "permission.asked":
      return `permission.asked:${raw.properties.id}`;
    case "question.asked":
      return `question.asked:${raw.properties.id}`;
    default:
      return raw.id;
  }
}
