import { describe, expect, test } from "bun:test";
import { decideFrame, eventsAfterSnapshot, parseServerFrame } from "./protocol";
import { eventFrame, snapshotFixture } from "./testing";

describe("eventsAfterSnapshot", () => {
  const buffered = [
    { event: "e9", seq: 9 },
    { event: "e10", seq: 10 },
    { event: "e11", seq: 11 },
  ];

  test("drops events at or below the snapshot sequence", () => {
    expect(eventsAfterSnapshot(buffered, 10).map((e) => e.seq)).toEqual([11]);
  });

  test("keeps events that arrived after the snapshot was cut", () => {
    expect(eventsAfterSnapshot(buffered, 8)).toHaveLength(3);
  });

  test("keeps everything when the snapshot is empty of history", () => {
    expect(eventsAfterSnapshot(buffered, 0)).toHaveLength(3);
  });

  test("drops everything when the snapshot is at or past the newest event", () => {
    expect(eventsAfterSnapshot(buffered, 11)).toEqual([]);
  });

  test("does not mutate the buffer it is given", () => {
    const input = [...buffered];
    eventsAfterSnapshot(input, 10);
    expect(input).toHaveLength(3);
  });
});

describe("decideFrame", () => {
  test("treats a frame ending at or below the cursor as a duplicate", () => {
    expect(decideFrame({ fromSeq: 4, seq: 6 }, 6)).toEqual({
      action: "duplicate",
      nextSeq: 6,
    });
  });

  test("treats a frame leaving a hole as a gap", () => {
    expect(decideFrame({ fromSeq: 4, seq: 9 }, 6)).toEqual({
      action: "gap",
      expected: 7,
      got: 4,
    });
  });

  test("treats a contiguous frame as applicable", () => {
    expect(decideFrame({ fromSeq: 7, seq: 9 }, 6)).toEqual({
      action: "apply",
      nextSeq: 9,
    });
  });

  test("treats an overlapping prefix as a gap rather than re-applying it", () => {
    expect(decideFrame({ fromSeq: 5, seq: 9 }, 6).action).toBe("gap");
  });

  test("never moves the cursor backwards", () => {
    expect(decideFrame({ fromSeq: 3, seq: 3 }, 10)).toEqual({
      action: "duplicate",
      nextSeq: 10,
    });
  });
});

describe("parseServerFrame", () => {
  test("accepts every server frame type", () => {
    for (const frame of [
      { head: 12, type: "ready" },
      { data: snapshotFixture(), seq: 4, type: "snapshot" },
      eventFrame(1, 1),
      { at: 1, type: "ping" },
      { message: "boom", type: "error" },
      { payload: { x: 1 }, timestamp: 5, type: "viewport.sync" },
    ]) {
      expect(parseServerFrame(JSON.stringify(frame))).not.toBeNull();
    }
  });

  test("returns null for malformed JSON and invalid shapes", () => {
    expect(parseServerFrame("{not json")).toBeNull();
    expect(parseServerFrame("")).toBeNull();
    expect(parseServerFrame(JSON.stringify({ nope: true }))).toBeNull();
    expect(
      parseServerFrame(JSON.stringify({ head: -1, type: "ready" }))
    ).toBeNull();
  });

  test("rejects a snapshot missing required preference fields", () => {
    expect(
      parseServerFrame(
        JSON.stringify({
          data: { boards: [], preferences: {}, selectedBoardId: null, v: 1 },
          seq: 1,
          type: "snapshot",
        })
      )
    ).toBeNull();
  });

  test("rejects an envelope whose boardId contradicts its event", () => {
    expect(
      parseServerFrame(
        JSON.stringify({
          ...eventFrame(1, 1, {
            boardId: "board-b",
            reviewMode: "auto",
            type: "board.review_mode_set",
          }),
          boardId: "board-a",
          event: {
            boardId: "board-b",
            reviewMode: "auto",
            ts: 1,
            type: "board.review_mode_set",
          },
        })
      )
    ).toBeNull();
  });

  test("rejects a backwards sequence range", () => {
    expect(
      parseServerFrame(JSON.stringify({ ...eventFrame(9, 5), fromSeq: 9 }))
    ).toBeNull();
  });
});
