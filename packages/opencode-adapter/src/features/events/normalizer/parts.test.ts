import { beforeEach, describe, expect, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { normalizeEvent } from "../normalizer";
import { resetMessageTracking } from "../normalizer/message-tracking";
import { assistantMessageUpdated } from "./test-support";

beforeEach(() => {
  resetMessageTracking();
});

describe("parts", () => {
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
    expect(result.sourceEventId).toBe("evt-0");
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

  test("normalizes running and completed edit diffs", () => {
    normalizeEvent(assistantMessageUpdated("sess-1", "msg-1"));

    const running = normalizeEvent({
      id: "evt-running-edit",
      type: "message.part.updated",
      properties: {
        sessionID: "sess-1",
        part: {
          id: "part-running-edit",
          sessionID: "sess-1",
          messageID: "msg-1",
          type: "tool",
          callID: "call-running-edit",
          tool: "edit",
          state: {
            status: "running",
            input: {
              filePath: "src/example.ts",
              oldString: "before",
              newString: "after",
            },
            time: { start: Date.now() },
          },
        },
        time: Date.now(),
      },
    } as OpencodeEvent);

    const completed = normalizeEvent({
      id: "evt-completed-edit",
      type: "message.part.updated",
      properties: {
        sessionID: "sess-1",
        part: {
          id: "part-completed-edit",
          sessionID: "sess-1",
          messageID: "msg-1",
          type: "tool",
          callID: "call-completed-edit",
          tool: "edit",
          state: {
            status: "completed",
            input: {},
            output: "updated",
            title: "Edit src/example.ts",
            metadata: {
              filediff: {
                file: "src/example.ts",
                before: "before",
                after: "after",
                additions: 1,
                deletions: 1,
              },
            },
            time: { start: Date.now(), end: Date.now() },
          },
        },
        time: Date.now(),
      },
    } as OpencodeEvent);

    expect(running.fileDiff).toEqual({
      filePath: "src/example.ts",
      before: "before",
      after: "after",
    });
    expect(completed.fileDiff).toEqual({
      filePath: "src/example.ts",
      before: "before",
      after: "after",
      additions: 1,
      deletions: 1,
    });
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
});
