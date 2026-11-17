import { afterEach, describe, expect, test } from "bun:test";
import {
  type Event,
  OpenCodeAdapter,
  resetMessageTracking,
  type SessionMessageWithParts,
} from "./index";

describe("OpenCodeAdapter history normalization", () => {
  afterEach(() => {
    resetMessageTracking();
  });

  test("keeps assistant message tracking in the adapter's event scope", () => {
    const adapter = OpenCodeAdapter.from({
      baseUrl: "http://engine-a",
      directory: "/repository",
    });
    const messages = [
      {
        info: {
          id: "message-resumed",
          role: "assistant",
          time: { created: 1234 },
        },
        parts: [
          {
            id: "reasoning-resumed",
            messageID: "message-resumed",
            sessionID: "session-resumed",
            text: "Recovered reasoning",
            type: "reasoning",
            time: { start: 1234 },
          },
        ],
      },
    ] as unknown as SessionMessageWithParts[];
    const delta = {
      id: "event-resumed-delta",
      properties: {
        delta: " resumed",
        field: "text",
        messageID: "message-resumed",
        partID: "reasoning-resumed",
        sessionID: "session-resumed",
      },
      type: "message.part.delta",
    } as unknown as Event;

    expect(adapter.normalizeHistory("session-resumed", messages)).toHaveLength(
      1
    );
    expect(adapter.normalize(delta).delta).toBe(" resumed");

    const otherEngine = OpenCodeAdapter.from({
      baseUrl: "http://engine-b",
      directory: "/repository",
    });
    expect(otherEngine.normalize(delta).delta).toBeUndefined();
  });
});
