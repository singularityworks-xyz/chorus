import { beforeEach, describe, expect, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { normalizeEvent } from "../normalizer";
import { resetMessageTracking } from "../normalizer/message-tracking";

beforeEach(() => {
  resetMessageTracking();
});

describe("requests", () => {
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
    expect(result.sourceEventId).toBe("permission.asked:perm-1");
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
    expect(normalizeEvent(raw).sourceEventId).toBe("question.asked:q-1");
  });
});
