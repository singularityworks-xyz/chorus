import { describe, expect, test } from "bun:test";
import { decideFrame, eventsAfterSnapshot } from "./protocol";

describe("eventsAfterSnapshot", () => {
  // A snapshot is cut at the server's head, so it already reflects every event
  // buffered in the transport. Replaying those duplicates cards and streamed
  // text, because the projector appends and concatenates.
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
    // Cannot happen against the hub, whose ranges never overlap, but re-applying
    // the prefix would duplicate state, so the safe reading is a snapshot.
    expect(decideFrame({ fromSeq: 5, seq: 9 }, 6).action).toBe("gap");
  });
});
