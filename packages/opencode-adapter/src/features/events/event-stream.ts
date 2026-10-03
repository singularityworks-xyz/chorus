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

    // Claim the slot before awaiting, so two concurrent subscribers cannot both
    // open a stream for the same directory.
    this.#dirSubscriptions.set(key, sub);

    // Deliberately NOT resetting `assistantMessageRoles` here.
    //
    // The map is global because `normalize` has no directory context, and the
    // engine does not replay `message.updated` for a message already in flight.
    // Clearing it on a new subscription therefore *causes* the silent content
    // drop it looks like it prevents: another board's in-flight parts lose the
    // only record that says whose text they are. Entries are session-scoped, so
    // one session never legitimately appears under two directories.

    let initial: Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>;
    try {
      initial = await this.client.event.subscribe({
        directory: options?.directory,
      });
    } catch (error) {
      // Release the claim. Leaving it behind meant every later attempt took the
      // "already subscribed" branch and returned a handle wired to nothing — a
      // dead subscription that looked perfectly healthy to its caller.
      this.#dirSubscriptions.delete(key);
      throw error;
    }

    // Reconnection runs detached so `subscribe` still resolves once the stream
    // is attached; awaiting the loop here would hang the caller forever.
    this.#pump(
      key,
      initial.stream as AsyncIterable<OCEvent>,
      onEvent,
      abort,
      options?.directory
    );

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

  /**
   * Keeps an event stream open for as long as the subscription is wanted.
   *
   * The engine's event stream is the only way agent activity reaches us, and it
   * ends for reasons unrelated to any run: a proxy timeout, an engine restart, a
   * dropped socket. `#consume` used to log that and give up, after which the
   * board silently stopped updating while the agent kept working.
   *
   * Retries with capped, jittered backoff. The attempt counter resets whenever a
   * stream actually delivered something, so a long-lived subscription that blips
   * occasionally reconnects indefinitely, while one that cannot stay open at all
   * is abandoned after `MAX_STREAM_RECONNECTS`.
   */
  async #pump(
    key: string,
    firstStream: AsyncIterable<OCEvent>,
    onEvent: EventCallback,
    abort: AbortController,
    directory: string | undefined
  ): Promise<void> {
    let stream: AsyncIterable<OCEvent> | null = firstStream;
    let attempts = 0;

    while (stream !== null) {
      let delivered = 0;

      try {
        delivered = await this.#consume(stream, onEvent, abort);
      } catch (error) {
        if (!this.#running || abort.signal.aborted) {
          this.#release(key);
          return;
        }
        console.error("[oc-adapter] event stream error:", error);
      }

      if (!this.#running || abort.signal.aborted) {
        this.#release(key);
        return;
      }

      // A stream that produced events was healthy up to the moment it ended, so
      // whatever follows starts fresh.
      attempts = delivered > 0 ? 0 : attempts + 1;

      if (attempts > MAX_STREAM_RECONNECTS) {
        console.error(
          "[oc-adapter] abandoning the event stream after repeated failures:",
          key
        );
        this.#release(key);
        return;
      }

      await this.#backoff(Math.max(attempts, 1), abort);

      if (!this.#running || abort.signal.aborted) {
        this.#release(key);
        return;
      }

      stream = await this.#reopen(directory, abort);
    }

    // `#reopen` returned null: the engine will not give us a stream, so the slot
    // must be released or every later subscriber gets a handle to a dead pump.
    this.#release(key);
  }

  /**
   * Drains one stream, returning how many events it delivered.
   *
   * Iterates manually rather than with `for await` so a pending `next()` can be
   * abandoned on abort: `for await` only checks between iterations, so a stream
   * that never settles again would hang the pump — and its slot — forever.
   */
  async #consume(
    stream: AsyncIterable<OCEvent>,
    onEvent: EventCallback,
    abort: AbortController
  ): Promise<number> {
    const iterator = stream[Symbol.asyncIterator]();
    let delivered = 0;

    try {
      for (;;) {
        if (!this.#running || abort.signal.aborted) {
          return delivered;
        }

        const next = await raceAbort(iterator.next(), abort.signal);
        if (next === ABORTED || next.done) {
          return delivered;
        }

        onEvent(next.value as OCEvent);
        delivered += 1;
      }
    } finally {
      // Closes the engine-side stream rather than leaving it open until the
      // engine happens to notice.
      await iterator.return?.(undefined).catch(() => undefined);
    }
  }

  /** Reopens the stream, or returns null when it will not open. */
  async #reopen(
    directory: string | undefined,
    abort: AbortController
  ): Promise<AsyncIterable<OCEvent> | null> {
    try {
      const reopened = await this.client.event.subscribe({ directory });
      return reopened.stream as AsyncIterable<OCEvent>;
    } catch (error) {
      if (!this.#running || abort.signal.aborted) {
        return null;
      }
      console.error("[oc-adapter] event resubscribe failed:", error);
      return null;
    }
  }

  /**
   * Drops a subscription's claim.
   *
   * Every exit from the pump has to do this. Missing one leaves a key behind, and
   * the next `subscribe` for that directory takes the "already subscribed" branch
   * and hands its caller a handle wired to a pump that no longer exists.
   */
  #release(key: string): void {
    this.#dirSubscriptions.delete(key);
    if (this.#dirSubscriptions.size === 0) {
      this.#running = false;
    }
  }

  /** Sleeps, resolving early if the subscription is stopped while waiting. */
  async #backoff(attempt: number, abort: AbortController): Promise<void> {
    const ceiling = Math.min(
      STREAM_RECONNECT_BASE_MS * 2 ** (attempt - 1),
      STREAM_RECONNECT_MAX_MS
    );
    const delayMs = Math.round(ceiling * Math.random());

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);

      // Removed on the normal path too. `{ once: true }` alone leaves a listener
      // behind on every reconnect, and they all run when `abort()` finally fires.
      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }

      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  stop() {
    this.#running = false;
    for (const sub of this.#dirSubscriptions.values()) {
      sub.abort.abort();
    }
    this.#dirSubscriptions.clear();
  }
}

/** Sentinel for "the subscription was aborted mid-read". */
const ABORTED = Symbol("aborted");

/**
 * Resolves with the iterator result, or `ABORTED` if the signal fires first.
 *
 * Without this a `next()` that never settles cannot be interrupted, so stopping
 * the subscription would leave the pump and its slot alive indefinitely.
 */
function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED);
  }

  return new Promise<T | typeof ABORTED>((resolve) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        resolve(Promise.reject(error));
      }
    );
  });
}

/** Backoff bounds for re-opening a dropped event stream. */
const STREAM_RECONNECT_BASE_MS = 250;
const STREAM_RECONNECT_MAX_MS = 10_000;

/** Consecutive failed reopens before a stream is abandoned. */
const MAX_STREAM_RECONNECTS = 10;

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
 * `message.updated` said. The map is global because `normalize` has no directory
 * context, and entries are session-scoped, so one session never legitimately
 * appears under two directories.
 *
 * Recorded roles are deliberately not cleared when a subscription starts. The
 * engine does not replay `message.updated` for a message already in flight, so
 * forgetting on reconnect would *cause* the silent content drop it looks like it
 * prevents: part events would miss and return a bare `{ type, sessionID }`, with
 * no error and nothing to distinguish them from the `default:` arm of
 * `normalizeEvent`. `resetMessageTracking` exists for tests and for a deliberate
 * full reset, not for routine subscription.
 *
 * It grew without bound, one entry per assistant message for the life of the
 * process. Capped per session now: the oldest entries are dropped, which costs a
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
