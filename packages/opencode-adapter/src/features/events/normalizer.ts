import type { Message, Event as OCEvent, Part } from "@opencode-ai/sdk/v2";

export type NormalizedActivity =
  | "writing"
  | "thinking"
  | "waiting_for_approval"
  | "waiting_for_question"
  | "error"
  | "idle";

export interface FileDiffInfo {
  additions?: number;
  after?: string;
  before?: string;
  deletions?: number;
  filePath: string;
}

export interface QuestionOption {
  description: string;
  label: string;
}

export interface QuestionInfo {
  custom?: boolean;
  header: string;
  multiple?: boolean;
  options: QuestionOption[];
  question: string;
}

export interface NormalizedAgentEvent {
  activity?: NormalizedActivity;
  delta?: string;
  error?: string;
  fileDiff?: FileDiffInfo;
  messageID?: string;
  partID?: string;
  partType?: "text" | "reasoning" | "tool";
  permission?: string;
  permissionID?: string;
  questionID?: string;
  questions?: QuestionInfo[];
  sessionID?: string;
  sourceEventId?: string;
  text?: string;
  timestamp: number;
  toolName?: string;
  toolState?: string;
  type: string;
}

export interface SessionMessageWithParts {
  info: Message;
  parts: Part[];
}

// History parts are absolute upserts, so they can repair missed stream deltas.
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
  message: Message,
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
  const normalized: NormalizedAgentEvent[] = [];
  for (const message of messages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    recordAssistantMessage(scope, sessionID, message.info.id);
    for (const part of message.parts) {
      const event = normalizeHistoryPart(sessionID, message.info, part);
      if (event) {
        normalized.push(event);
      }
    }
  }
  return normalized;
}

function safeNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function safeStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function extractFileDiffFromCompleted(
  toolName: string,
  metadata: Record<string, unknown>
): FileDiffInfo | undefined {
  if ((toolName === "edit" || toolName === "write") && metadata.filediff) {
    const fd = metadata.filediff as Record<string, unknown>;
    return {
      additions: safeNum(fd.additions),
      after: safeStr(fd.after),
      before: safeStr(fd.before),
      deletions: safeNum(fd.deletions),
      filePath: safeStr(fd.file) ?? "",
    };
  }
  if (toolName === "apply_patch" && Array.isArray(metadata.files)) {
    const files = metadata.files as Record<string, unknown>[];
    if (files.length === 0) {
      return undefined;
    }
    const f = files[0];
    return {
      additions: safeNum(f.additions),
      after: safeStr(f.after),
      before: safeStr(f.before),
      deletions: safeNum(f.deletions),
      filePath: safeStr(f.filePath) ?? "",
    };
  }
  return undefined;
}

function extractFileDiffFromRunning(
  toolName: string,
  input: Record<string, unknown>
): FileDiffInfo | undefined {
  if (
    (toolName === "edit" || toolName === "write") &&
    typeof input.filePath === "string"
  ) {
    const diff: FileDiffInfo = { filePath: input.filePath };
    if (
      toolName === "edit" &&
      typeof input.oldString === "string" &&
      typeof input.newString === "string"
    ) {
      diff.before = input.oldString;
      diff.after = input.newString;
    }
    return diff;
  }
  return undefined;
}

function extractFileDiff(
  toolName: string,
  state: {
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    status: string;
  }
): FileDiffInfo | undefined {
  if (state.status === "completed" && state.metadata) {
    return extractFileDiffFromCompleted(toolName, state.metadata);
  }
  if (state.status === "running" && state.input) {
    return extractFileDiffFromRunning(toolName, state.input);
  }
  return undefined;
}

// Part events omit roles; retain bounded message tracking across reconnects.
const assistantMessageRoles = new Map<string, Set<string>>();

const MAX_TRACKED_MESSAGES_PER_SESSION = 512;
const MAX_TRACKED_SESSIONS = 4096;

function roleScope(scope: string, sessionID: string): string {
  return `${scope}\0${sessionID}`;
}

function isAssistantMessage(
  scope: string,
  sessionID: string,
  messageID: string
): boolean {
  const sessionRoles = assistantMessageRoles.get(roleScope(scope, sessionID));
  return sessionRoles?.has(messageID) ?? false;
}

function recordAssistantMessage(
  scope: string,
  sessionID: string,
  messageID: string
) {
  const key = roleScope(scope, sessionID);
  let sessionRoles = assistantMessageRoles.get(key);
  if (sessionRoles) {
    // Refresh least-recently-used session order.
    assistantMessageRoles.delete(key);
    assistantMessageRoles.set(key, sessionRoles);
  } else {
    sessionRoles = new Set();
    if (assistantMessageRoles.size >= MAX_TRACKED_SESSIONS) {
      const oldest = assistantMessageRoles.keys().next();
      if (!oldest.done) {
        assistantMessageRoles.delete(oldest.value);
      }
    }
    assistantMessageRoles.set(key, sessionRoles);
  }

  if (sessionRoles.size >= MAX_TRACKED_MESSAGES_PER_SESSION) {
    const oldest = sessionRoles.values().next();
    if (!oldest.done) {
      sessionRoles.delete(oldest.value);
    }
  }

  sessionRoles.add(messageID);
}

/** Test hook; subscriptions must preserve this state across reconnects. */
export function resetMessageTracking(): void {
  assistantMessageRoles.clear();
}

function normalizeMessagePartUpdated(
  base: NormalizedAgentEvent,
  raw: Extract<OCEvent, { type: "message.part.updated" }>,
  scope: string
): NormalizedAgentEvent {
  const part = raw.properties.part;
  const sessionID = raw.properties.sessionID;
  const messageID = part.messageID;

  if (!isAssistantMessage(scope, sessionID, messageID)) {
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

  if (!isAssistantMessage(scope, sessionID, messageID)) {
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
