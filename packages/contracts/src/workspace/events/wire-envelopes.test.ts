import { describe, expect, test } from "bun:test";
import { WORKSPACE_SNAPSHOT_VERSION } from "../events";
import {
  createVersionedSnapshot,
  MAX_REPLAY_GAP,
  sequencedEventSchema,
  serverMessageSchema,
  snapshotMessageSchema,
  WS_CLOSE_RATE_LIMITED,
  WS_CLOSE_UNAUTHORIZED,
} from "../protocol";
import { board, EVENT_CORPUS, TS } from "./test-support";

describe("wire envelopes", () => {
  test("a sequenced event carries seq, ts, boardId and the event", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      seq: 1042,
      fromSeq: 1042,
      ts: TS,
      boardId: "board-1",
      event: EVENT_CORPUS["card.waiting_for_approval"],
    });
    expect(message.event.type).toBe("card.waiting_for_approval");
  });

  test("a sequenced event may be workspace scoped", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      seq: 1043,
      fromSeq: 1043,
      ts: TS,
      boardId: null,
      event: EVENT_CORPUS["preference.speech_voice_set"],
    });
    expect(message.boardId).toBeNull();
  });

  test("a coalesced frame declares the range it covers", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      fromSeq: 6,
      seq: 500,
      ts: TS,
      boardId: "board-1",
      event: EVENT_CORPUS["card.waiting_for_approval"],
    });
    expect(message.fromSeq).toBe(6);
    expect(message.seq).toBe(500);
  });

  test("rejects a frame whose range runs backwards", () => {
    expect(() =>
      sequencedEventSchema.parse({
        type: "event",
        fromSeq: 501,
        seq: 500,
        ts: TS,
        boardId: "board-1",
        event: EVENT_CORPUS["card.waiting_for_approval"],
      })
    ).toThrow();
  });

  test("every server frame the hub emits is in the message union", () => {
    for (const frame of [
      { at: TS, type: "ping" },
      { head: 4, protocolVersion: "1", type: "ready" },
      { payload: { x: 1 }, timestamp: TS, type: "viewport.sync" },
      {
        type: "event",
        fromSeq: 4,
        seq: 4,
        ts: TS,
        boardId: "board-1",
        event: EVENT_CORPUS["card.started"],
      },
      {
        type: "snapshot",
        seq: 4,
        data: {
          boards: [],
          preferences: { composerHintDismissed: false },
          selectedBoardId: null,
          v: 1,
        },
      },
      { type: "error", message: "boom" },
    ]) {
      expect(serverMessageSchema.safeParse(frame).success).toBe(true);
    }
  });

  test("rejects a negative seq", () => {
    expect(() =>
      sequencedEventSchema.parse({
        type: "event",
        seq: -1,
        ts: TS,
        boardId: "board-1",
        event: EVENT_CORPUS["card.started"],
      })
    ).toThrow();
  });

  test("a snapshot message is versioned at v1", () => {
    const workspace = {
      boards: [board],
      preferences: {
        boardViewMode: "relaxed" as const,
        composerHintDismissed: false,
        recentlyUsedModels: [],
        speechVoiceId: null,
      },
      selectedBoardId: "board-1",
    };
    const versioned = createVersionedSnapshot(workspace);
    expect(versioned.v).toBe(WORKSPACE_SNAPSHOT_VERSION);

    const message = snapshotMessageSchema.parse({
      type: "snapshot",
      seq: 2087,
      data: versioned,
    });
    expect(message.seq).toBe(2087);
  });

  test("a snapshot with a malformed board is rejected", () => {
    expect(() =>
      snapshotMessageSchema.parse({
        type: "snapshot",
        seq: 1,
        data: {
          boards: [{ boardId: "b1" }],
          preferences: {},
          selectedBoardId: "b1",
          v: 1,
        },
      })
    ).toThrow();
  });

  test("a snapshot with malformed preferences is rejected", () => {
    expect(() =>
      snapshotMessageSchema.parse({
        type: "snapshot",
        seq: 1,
        data: {
          boards: [board],
          preferences: { recentlyUsedModels: "nope" },
          selectedBoardId: "b1",
          v: 1,
        },
      })
    ).toThrow();
  });

  test("rejects an envelope whose boardId disagrees with the event", () => {
    expect(() =>
      sequencedEventSchema.parse({
        type: "event",
        seq: 1042,
        fromSeq: 1042,
        ts: TS,
        boardId: "board-other",
        event: EVENT_CORPUS["card.started"],
      })
    ).toThrow();
  });

  test("rejects an envelope claiming a board for a workspace-scoped event", () => {
    expect(() =>
      sequencedEventSchema.parse({
        type: "event",
        seq: 1043,
        fromSeq: 1043,
        ts: TS,
        boardId: "board-1",
        event: EVENT_CORPUS["preference.speech_voice_set"],
      })
    ).toThrow();
  });

  test("accepts a workspace-scoped envelope with a null boardId", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      seq: 1044,
      fromSeq: 1044,
      ts: TS,
      boardId: null,
      event: EVENT_CORPUS["preference.speech_voice_set"],
    });
    expect(message.boardId).toBeNull();
  });

  test("accepts a deselected board.selected envelope", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      seq: 1045,
      fromSeq: 1045,
      ts: TS,
      boardId: null,
      event: { type: "board.selected", ts: TS, boardId: null },
    });
    expect(message.boardId).toBeNull();
  });

  test("rejects a snapshot with an unknown version", () => {
    expect(() =>
      snapshotMessageSchema.parse({
        type: "snapshot",
        seq: 1,
        data: {
          boards: [],
          preferences: {},
          selectedBoardId: null,
          v: 99,
        },
      })
    ).toThrow();
  });

  test("server message union parses ready and error shapes", () => {
    expect(serverMessageSchema.parse({ type: "ready", head: 2087 }).head).toBe(
      2087
    );
    expect(
      serverMessageSchema.parse({ type: "error", message: "nope" }).message
    ).toBe("nope");
  });

  test("protocol constants match the spec", () => {
    expect(MAX_REPLAY_GAP).toBe(500);
    expect(WS_CLOSE_UNAUTHORIZED).toBe(4401);
    expect(WS_CLOSE_RATE_LIMITED).toBe(4429);
  });
});
