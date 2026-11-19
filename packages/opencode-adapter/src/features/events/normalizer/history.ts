import type { Part } from "@opencode-ai/sdk/v2";
import { extractFileDiff } from "./file-diff";
import { recordAssistantMessage } from "./message-tracking";
import type {
  NormalizedActivity,
  NormalizedAgentEvent,
  SessionMessageWithParts,
} from "./types";

function historicalToolActivity(
  status: Extract<Part, { type: "tool" }>["state"]["status"]
): NormalizedActivity {
  if (status === "error") {
    return "error";
  }
  if (status === "running" || status === "pending") {
    return "thinking";
  }
  return "writing";
}

function normalizeHistoryPart(
  sessionID: string,
  message: SessionMessageWithParts["info"],
  part: Part
): NormalizedAgentEvent | null {
  const base = {
    messageID: message.id,
    sessionID,
    sourceEventId: `history:${message.id}:${part.id}`,
    timestamp: message.time.created,
  } satisfies Partial<NormalizedAgentEvent>;

  if (part.type === "text") {
    return {
      ...base,
      activity: "writing",
      partID: part.id,
      partType: "text",
      text: part.text,
      type: "message.part.updated",
    };
  }
  if (part.type === "reasoning") {
    return {
      ...base,
      activity: "thinking",
      partID: part.id,
      partType: "reasoning",
      text: part.text,
      type: "message.part.updated",
    };
  }
  if (part.type === "tool") {
    return {
      ...base,
      activity: historicalToolActivity(part.state.status),
      fileDiff: extractFileDiff(part.tool, part.state),
      partID: part.id,
      partType: "tool",
      toolName: part.tool,
      toolState: part.state.status,
      type: "message.part.updated",
    };
  }
  return null;
}

export function normalizeSessionHistory(
  sessionID: string,
  messages: SessionMessageWithParts[],
  scope = "default"
): NormalizedAgentEvent[] {
  const events: NormalizedAgentEvent[] = [];
  for (const message of messages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    recordAssistantMessage(scope, sessionID, message.info.id);
    for (const part of message.parts) {
      const event = normalizeHistoryPart(sessionID, message.info, part);
      if (event) {
        events.push(event);
      }
    }
  }
  return events;
}
