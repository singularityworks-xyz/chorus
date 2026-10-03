import { beforeEach, describe, expect, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { normalizeEvent, resetMessageTracking } from "./event-stream";

// Real opencode streams deliver message.updated (role=assistant) before any
// of that message's part events; the normalizer relies on it to classify
// parts. Every part-event test therefore records the parent message first.
function assistantMessageUpdated(sessionID: string, messageID: string) {
  return {
    id: `evt-${messageID}`,
    type: "message.updated",
    properties: {
      sessionID,
      info: { id: messageID, role: "assistant" },
    },
  } as OpencodeEvent;
}

describe("normalizeEvent", () => {
  beforeEach(() => {
    resetMessageTracking();
  });

  test("normalizes text part as writing activity", () => {
    const raw = {
      id: "evt-0",
      type: "message.part.updated",
      properties: {
        sessionID: "sess-1",
        part: {
          id: "part-1",
          sessionID: "sess-1",
          messageID: "msg-1",
          type: "text",
          text: "hello world",
          time: { start: Date.now() },
        },
        time: Date.now(),
      },
    } as OpencodeEvent;

    normalizeEvent(assistantMessageUpdated("sess-1", "msg-1"));
    const result = normalizeEvent(raw);

    expect(result.type).toBe("message.part.updated");
    expect(result.sessionID).toBe("sess-1");
    expect(result.activity).toBe("writing");
    expect(result.text).toBe("hello world");
  });

  test("normalizes tool part with running state as thinking", () => {
    const raw = {
      id: "evt-1",
      type: "message.part.updated",
      properties: {
        sessionID: "sess-1",
        part: {
          id: "part-1",
          sessionID: "sess-1",
          messageID: "msg-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: {},
            time: { start: Date.now() },
          },
        },
        time: Date.now(),
      },
    } as OpencodeEvent;

    normalizeEvent(assistantMessageUpdated("sess-1", "msg-1"));
    const result = normalizeEvent(raw);

    expect(result.activity).toBe("thinking");
    expect(result.toolName).toBe("bash");
    expect(result.toolState).toBe("running");
  });

  test("normalizes tool part with completed state as writing", () => {
    const raw = {
      id: "evt-2",
      type: "message.part.updated",
      properties: {
        sessionID: "sess-1",
        part: {
          id: "part-1",
          sessionID: "sess-1",
          messageID: "msg-1",
          type: "tool",
          callID: "call-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "file content",
            title: "read file",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        },
        time: Date.now(),
      },
    } as OpencodeEvent;

    normalizeEvent(assistantMessageUpdated("sess-1", "msg-1"));
    const result = normalizeEvent(raw);

    expect(result.activity).toBe("writing");
    expect(result.toolName).toBe("read");
    expect(result.toolState).toBe("completed");
  });

  test("normalizes reasoning part as thinking", () => {
    const raw = {
      id: "evt-3",
      type: "message.part.updated",
      properties: {
        sessionID: "sess-1",
        part: {
          id: "part-1",
          sessionID: "sess-1",
          messageID: "msg-1",
          type: "reasoning",
          text: "let me think about this",
          time: { start: Date.now() },
        },
        time: Date.now(),
      },
    } as OpencodeEvent;

    normalizeEvent(assistantMessageUpdated("sess-1", "msg-1"));
    const result = normalizeEvent(raw);

    expect(result.activity).toBe("thinking");
    expect(result.text).toBe("let me think about this");
  });

  test("normalizes session.status busy as thinking", () => {
    const raw = {
      id: "evt-4",
      type: "session.status",
      properties: {
        sessionID: "sess-1",
        status: { type: "busy" },
      },
    } as OpencodeEvent;

    const result = normalizeEvent(raw);

    expect(result.activity).toBe("thinking");
    expect(result.sessionID).toBe("sess-1");
  });

  test("normalizes session.status idle as idle", () => {
    const raw = {
      id: "evt-5",
      type: "session.status",
      properties: {
        sessionID: "sess-1",
        status: { type: "idle" },
      },
    } as OpencodeEvent;

    const result = normalizeEvent(raw);

    expect(result.activity).toBe("idle");
  });

  test("normalizes session.status retry as thinking", () => {
    const raw = {
      id: "evt-6",
      type: "session.status",
      properties: {
        sessionID: "sess-1",
        status: { type: "retry", attempt: 1, message: "retrying", next: 1000 },
      },
    } as OpencodeEvent;

    const result = normalizeEvent(raw);

    expect(result.activity).toBe("thinking");
  });

  test("normalizes session.idle as idle", () => {
    const raw = {
      id: "evt-7",
      type: "session.idle",
      properties: {
        sessionID: "sess-1",
      },
    } as OpencodeEvent;

    const result = normalizeEvent(raw);

    expect(result.activity).toBe("idle");
    expect(result.sessionID).toBe("sess-1");
  });

  test("normalizes permission.asked as waiting_for_approval", () => {
    const raw = {
      id: "evt-8",
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "sess-1",
        permission: "edit",
        patterns: ["*.ts"],
        metadata: {},
        always: [],
      },
    } as OpencodeEvent;

    const result = normalizeEvent(raw);

    expect(result.activity).toBe("waiting_for_approval");
    expect(result.permissionID).toBe("perm-1");
    expect(result.sessionID).toBe("sess-1");
  });

  test("normalizes session.error as error", () => {
    const raw = {
      id: "evt-9",
      type: "session.error",
      properties: {
        sessionID: "sess-1",
        error: {
          name: "APIError",
          data: { message: "rate limited", isRetryable: true },
        },
      },
    } as OpencodeEvent;

    const result = normalizeEvent(raw);

    expect(result.activity).toBe("error");
    expect(result.error).toBe("rate limited");
    expect(result.sessionID).toBe("sess-1");
  });

  test("normalizes message.updated with error as error", () => {
    const raw = {
      id: "evt-10",
      type: "message.updated",
      properties: {
        sessionID: "sess-1",
        info: {
          id: "msg-1",
          sessionID: "sess-1",
          role: "assistant",
          time: { created: Date.now() },
          error: {
            name: "MessageOutputLengthError",
            data: { message: "output too long" },
          },
          parentID: "parent-1",
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    } as OpencodeEvent;

    const result = normalizeEvent(raw);

    expect(result.activity).toBe("error");
    expect(result.error).toBe("output too long");
  });

  test("returns base event for unknown types", () => {
    const raw = {
      id: "evt-11",
      type: "project.updated",
      properties: {
        id: "proj-1",
        worktree: "/tmp",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    } as OpencodeEvent;

    const result = normalizeEvent(raw);

    expect(result.type).toBe("project.updated");
    expect(result.timestamp).toBeDefined();
  });

  // SDK 1.18 requires an `id` on every event; the fixtures above all carry one.
  test("normalizes message.part.delta as a delta with a part id", () => {
    resetMessageTracking();
    const sessionID = "sess-delta";
    normalizeEvent({
      id: "evt-m",
      properties: { info: { id: "msg-1", role: "assistant" }, sessionID },
      type: "message.updated",
    } as OpencodeEvent);

    const raw = {
      id: "evt-d",
      properties: {
        delta: "Hel",
        field: "text",
        messageID: "msg-1",
        partID: "part-1",
        sessionID,
      },
      type: "message.part.delta",
    } as OpencodeEvent;

    const normalized = normalizeEvent(raw);

    expect(normalized.delta).toBe("Hel");
    expect(normalized.partID).toBe("part-1");
    expect(normalized.messageID).toBe("msg-1");
    expect(normalized.sessionID).toBe(sessionID);
  });

  test("normalizes question.asked as waiting_for_question", () => {
    const raw = {
      id: "evt-q",
      properties: {
        id: "q-1",
        questions: [{ header: "Which?", options: [] }],
        sessionID: "sess-q",
      },
      type: "question.asked",
    } as unknown as OpencodeEvent;

    expect(normalizeEvent(raw).activity).toBe("waiting_for_question");
  });

  test("an unrecorded parent message drops part content instead of guessing", () => {
    // The engine did not tell us this message is assistant-authored, so the
    // normalizer refuses rather than attributing text it cannot place.
    const raw = {
      id: "evt-orphan",
      properties: {
        delta: "guess",
        field: "text",
        messageID: "msg-never-seen",
        partID: "part-1",
        sessionID: "sess-orphan",
      },
      type: "message.part.delta",
    } as OpencodeEvent;

    const normalized = normalizeEvent(raw);

    expect(normalized.delta).toBeUndefined();
    expect(normalized.text).toBeUndefined();
    expect(normalized.sessionID).toBe("sess-orphan");
  });

  test("resetMessageTracking makes a reconnect stop trusting stale bookkeeping", () => {
    const sessionID = "sess-reconnect";
    const parent = {
      id: "evt-p",
      properties: { info: { id: "msg-1", role: "assistant" }, sessionID },
      type: "message.updated",
    } as OpencodeEvent;

    normalizeEvent(parent);
    const before = normalizeEvent({
      id: "evt-1",
      properties: {
        delta: "kept",
        field: "text",
        messageID: "msg-1",
        partID: "part-1",
        sessionID,
      },
      type: "message.part.delta",
    } as OpencodeEvent);
    expect(before.delta).toBe("kept");

    // A reconnect: the engine will not replay the parent, so the remembered role
    // is exactly the thing that would otherwise mask the gap.
    resetMessageTracking();

    const after = normalizeEvent({
      id: "evt-2",
      properties: {
        delta: "dropped",
        field: "text",
        messageID: "msg-1",
        partID: "part-1",
        sessionID,
      },
      type: "message.part.delta",
    } as OpencodeEvent);
    expect(after.delta).toBeUndefined();
  });
});
