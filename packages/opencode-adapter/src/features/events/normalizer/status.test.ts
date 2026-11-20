import { beforeEach, describe, expect, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { normalizeEvent } from "../normalizer";
import { resetMessageTracking } from "../normalizer/message-tracking";

beforeEach(() => {
  resetMessageTracking();
});

describe("status", () => {
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
});
