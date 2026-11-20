import { beforeEach, describe, expect, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { normalizeEvent } from "../normalizer";
import { resetMessageTracking } from "../normalizer/message-tracking";

beforeEach(() => {
  resetMessageTracking();
});

describe("errors", () => {
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
});
