import { beforeEach, describe, expect, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { normalizeEvent } from "../normalizer";
import { normalizeSessionHistory } from "../normalizer/history";
import { resetMessageTracking } from "../normalizer/message-tracking";
import type { SessionMessageWithParts } from "../normalizer/types";
import { assistantMessageUpdated } from "./test-support";

beforeEach(() => {
  resetMessageTracking();
});

describe("history", () => {
  test("rebuilds stable assistant part upserts from session history", () => {
    const messages = [
      {
        info: {
          id: "msg-history",
          role: "assistant",
          time: { created: 1234 },
        },
        parts: [
          {
            id: "part-history",
            messageID: "msg-history",
            sessionID: "sess-history",
            text: "Recovered answer",
            type: "text",
          },
        ],
      },
    ] as unknown as SessionMessageWithParts[];

    const [event] = normalizeSessionHistory(
      "sess-history",
      messages,
      "engine-a"
    );

    expect(event).toMatchObject({
      activity: "writing",
      messageID: "msg-history",
      partID: "part-history",
      sessionID: "sess-history",
      sourceEventId: "history:msg-history:part-history",
      text: "Recovered answer",
      type: "message.part.updated",
    });
  });

  test("scopes assistant message tracking to the engine and session", () => {
    const sessionID = "sess-shared-id";
    const parent = assistantMessageUpdated(sessionID, "msg-scoped");
    const delta = {
      id: "evt-scoped-delta",
      properties: {
        delta: "recognized",
        field: "text",
        messageID: "msg-scoped",
        partID: "part-scoped",
        sessionID,
      },
      type: "message.part.delta",
    } as OpencodeEvent;

    normalizeEvent(parent, "engine-a");

    expect(normalizeEvent(delta, "engine-a").delta).toBe("recognized");
    expect(normalizeEvent(delta, "engine-b").delta).toBeUndefined();
  });

  test("an unrecorded parent message drops part content instead of guessing", () => {
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
