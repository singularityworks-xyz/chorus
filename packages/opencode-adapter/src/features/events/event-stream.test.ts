import { describe, expect, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { normalizeEvent } from "./event-stream";

// Real opencode streams deliver message.updated (role=assistant) before any
// of that message's part events; the normalizer relies on it to classify
// parts. Every part-event test therefore records the parent message first.
function assistantMessageUpdated(sessionID: string, messageID: string) {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: { id: messageID, role: "assistant" },
    },
  } as OpencodeEvent;
}

describe("normalizeEvent", () => {
  test("normalizes text part as writing activity", () => {
    const raw = {
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
});
