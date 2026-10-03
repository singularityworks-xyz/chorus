import type { Event as OCEvent, OpencodeClient } from "@opencode-ai/sdk/v2";

export type { Event as AgentEvent, SessionStatus } from "@opencode-ai/sdk/v2";

export type EventCallback = (event: OCEvent) => void;

export interface EventStreamHandle {
  stop: () => void;
}

interface DirSubscription {
  abort: AbortController;
}

export class EventStream {
  readonly client: OpencodeClient;
  #running = false;
  readonly #dirSubscriptions = new Map<string, DirSubscription>();

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async subscribe(
    onEvent: EventCallback,
    options?: { directory?: string }
  ): Promise<EventStreamHandle> {
    this.#running = true;

    const key = options?.directory ?? "__default__";

    if (this.#dirSubscriptions.has(key)) {
      return {
        stop: () => {
          this.#dirSubscriptions.delete(key);
          if (this.#dirSubscriptions.size === 0) {
            this.#running = false;
          }
        },
      };
    }

    const abort = new AbortController();
    const sub: DirSubscription = { abort };
    this.#dirSubscriptions.set(key, sub);

    // A fresh subscription must not be judged against remembered roles from a
    // previous one: the engine does not replay `message.updated` for messages
    // already in flight, so stale-but-present entries are the only thing keeping
    // that from silently dropping content.
    resetMessageTracking();

    const events = await this.client.event.subscribe({
      directory: options?.directory,
    });

    this.#consume(
      events.stream as AsyncIterable<OCEvent>,
      onEvent,
      abort
    ).catch(() => {
      // stream errors are handled internally by the subscription
    });

    return {
      stop: () => {
        this.#dirSubscriptions.delete(key);
        abort.abort();
        if (this.#dirSubscriptions.size === 0) {
          this.#running = false;
        }
      },
    };
  }

  async #consume(
    stream: AsyncIterable<OCEvent>,
    onEvent: EventCallback,
    abort: AbortController
  ): Promise<void> {
    try {
      for await (const event of stream) {
        if (!this.#running || abort.signal.aborted) {
          break;
        }
        onEvent(event);
      }
    } catch (error) {
      if (this.#running && !abort.signal.aborted) {
        console.error("[oc-adapter] event stream error:", error);
      }
    }
  }

  stop() {
    this.#running = false;
    for (const sub of this.#dirSubscriptions.values()) {
      sub.abort.abort();
    }
    this.#dirSubscriptions.clear();
  }
}

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
  permissionID?: string;
  questionID?: string;
  questions?: QuestionInfo[];
  sessionID?: string;
  text?: string;
  timestamp: number;
  toolName?: string;
  toolState?: string;
  type: string;
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

/**
 * Which messages the engine has said are assistant-authored, per session.
 *
 * Part events carry no role, so the normalizer has to remember what
 * `message.updated` said. Two properties matter and neither was guaranteed:
 *
 * It was never cleared. A reconnect re-subscribes to a live stream that will not
 * replay the `message.updated` for messages already in flight, so every part
 * event for those messages hit the `isAssistantMessage` miss and returned a bare
 * `{ type, sessionID }` — all content discarded, no error, and the `default:` arm
 * of `normalizeEvent` is indistinguishable from it. `resetMessageTracking` is
 * called when a subscription starts; the miss then loses only the part events
 * whose parent has genuinely not been seen.
 *
 * It also grew without bound, one entry per assistant message for the life of the
 * process. Capped per session: the oldest entries are dropped, which costs a
 * little classification accuracy on a very long session rather than a leak.
 */
const assistantMessageRoles = new Map<string, Set<string>>();

const MAX_TRACKED_MESSAGES_PER_SESSION = 512;

function isAssistantMessage(sessionID: string, messageID: string): boolean {
  const sessionRoles = assistantMessageRoles.get(sessionID);
  return sessionRoles?.has(messageID) ?? false;
}

function recordAssistantMessage(sessionID: string, messageID: string) {
  let sessionRoles = assistantMessageRoles.get(sessionID);
  if (!sessionRoles) {
    sessionRoles = new Set();
    assistantMessageRoles.set(sessionID, sessionRoles);
  }

  if (sessionRoles.size >= MAX_TRACKED_MESSAGES_PER_SESSION) {
    const oldest = sessionRoles.values().next();
    if (!oldest.done) {
      sessionRoles.delete(oldest.value);
    }
  }

  sessionRoles.add(messageID);
}

/**
 * Forgets remembered assistant messages.
 *
 * Called when a stream subscription starts so a reconnect is not judged against
 * bookkeeping from before it. Exported for the adapter's tests, which otherwise
 * leak state between cases.
 */
export function resetMessageTracking(): void {
  assistantMessageRoles.clear();
}

function normalizeMessagePartUpdated(
  base: NormalizedAgentEvent,
  raw: Extract<OCEvent, { type: "message.part.updated" }>
): NormalizedAgentEvent {
  const part = raw.properties.part;
  const sessionID = raw.properties.sessionID;
  const messageID = part.messageID;

  if (!isAssistantMessage(sessionID, messageID)) {
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
  raw: Extract<OCEvent, { type: "message.part.delta" }>
): NormalizedAgentEvent {
  const props = raw.properties;
  const sessionID = props.sessionID;
  const messageID = props.messageID;

  if (!isAssistantMessage(sessionID, messageID)) {
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
  raw: Extract<OCEvent, { type: "message.updated" }>
): NormalizedAgentEvent {
  const info = raw.properties.info;
  const sessionID = raw.properties.sessionID;
  const messageID = info.id;

  if (info.role === "assistant") {
    recordAssistantMessage(sessionID, messageID);
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

export function normalizeEvent(raw: OCEvent): NormalizedAgentEvent {
  const base: NormalizedAgentEvent = {
    type: raw.type,
    timestamp: Date.now(),
  };

  switch (raw.type) {
    case "message.part.updated":
      return normalizeMessagePartUpdated(base, raw);
    case "message.part.delta":
      return normalizeMessagePartDelta(base, raw);
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
      return normalizeMessageUpdated(base, raw);
    default:
      return base;
  }
}
