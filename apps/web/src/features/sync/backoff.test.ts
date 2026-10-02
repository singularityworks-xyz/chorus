import { describe, expect, test } from "bun:test";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, Backoff } from "./backoff";
import { resolveSocketUrl } from "./chorus-sync";
import { decideFrame, parseServerFrame } from "./protocol";
import { eventFrame, snapshotFixture } from "./testing";

describe("Backoff (plan P5 task 1)", () => {
  test("the documented schedule starts at 250 ms and caps at 30 s", () => {
    expect(BACKOFF_BASE_MS).toBe(250);
    expect(BACKOFF_MAX_MS).toBe(30_000);

    const backoff = new Backoff({ random: () => 1 });

    // The ceiling is what the schedule is allowed to reach; `random() === 1`
    // makes the drawn delay equal it, so the sequence is the schedule itself.
    const schedule: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      schedule.push(Math.round(backoff.next()));
    }

    expect(schedule.slice(0, 6)).toEqual([250, 500, 1000, 2000, 4000, 8000]);
    // Never above the cap, however many attempts have accumulated.
    expect(Math.max(...schedule)).toBe(BACKOFF_MAX_MS);
    expect(schedule.at(-1)).toBe(BACKOFF_MAX_MS);
  });

  test("the ceiling doubles until it saturates", () => {
    const backoff = new Backoff();

    expect(backoff.ceilingForAttempt).toBe(250);
    backoff.next();
    expect(backoff.ceilingForAttempt).toBe(500);
    backoff.next();
    expect(backoff.ceilingForAttempt).toBe(1000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      backoff.next();
    }
    expect(backoff.ceilingForAttempt).toBe(BACKOFF_MAX_MS);
  });

  test("jitter stays within [0, ceiling)", () => {
    const low = new Backoff({ random: () => 0 });
    const high = new Backoff({ random: () => 0.999_999 });

    expect(low.next()).toBe(0);
    expect(high.next()).toBeLessThan(high.ceilingForAttempt + 1);
  });

  test("jitter is full-jitter, so a reconnect can be immediate", () => {
    // Full jitter matters: every client dropped by a serve restart must not
    // reconnect on the same schedule and arrive as a thundering herd, and a
    // client must never be forced to sit out a long backoff once it is able to
    // connect.
    const backoff = new Backoff({ random: () => 0 });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(backoff.next()).toBe(0);
    }
  });

  test("reset returns to the first attempt", () => {
    const backoff = new Backoff({ random: () => 1 });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      backoff.next();
    }
    expect(backoff.attempt).toBe(6);

    backoff.reset();

    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(250);
  });

  test("base and cap are configurable", () => {
    const backoff = new Backoff({
      baseMs: 10,
      maxMs: 40,
      random: () => 1,
    });

    const delays = [
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
    ];

    expect(delays).toEqual([10, 20, 40, 40]);
  });
});

describe("decideFrame (plan P5 task 1 — gap ⇒ resync)", () => {
  test("a contiguous frame is applied", () => {
    expect(decideFrame({ fromSeq: 6, seq: 6 }, 5)).toEqual({
      action: "apply",
      nextSeq: 6,
    });
  });

  test("a coalesced frame covering a run advances to its high sequence", () => {
    // The hub coalesces log rows 6..500 into one frame. The client's cursor must
    // land on 500, not 6 — resuming from 6 would replay 7..500 over the top of a
    // transcript that already contains them.
    expect(decideFrame({ fromSeq: 6, seq: 500 }, 5)).toEqual({
      action: "apply",
      nextSeq: 500,
    });
  });

  test("a frame already covered is a duplicate", () => {
    expect(decideFrame({ fromSeq: 4, seq: 6 }, 6)).toEqual({
      action: "duplicate",
      nextSeq: 6,
    });
  });

  test("a frame that starts past the cursor is a gap", () => {
    expect(decideFrame({ fromSeq: 9, seq: 9 }, 6)).toEqual({
      action: "gap",
      expected: 7,
      got: 9,
    });
  });

  test("the first frame after a fresh handshake applies from zero", () => {
    expect(decideFrame({ fromSeq: 1, seq: 1 }, 0)).toEqual({
      action: "apply",
      nextSeq: 1,
    });
  });

  test("a frame overlapping the cursor without being covered is a gap", () => {
    // Cannot happen against the hub, whose ranges never overlap. Treated as a gap
    // because re-applying an overlapping prefix would corrupt a transcript, and
    // one snapshot is cheaper than that.
    expect(decideFrame({ fromSeq: 4, seq: 9 }, 6).action).toBe("gap");
  });

  test("the cursor never moves backwards", () => {
    const decision = decideFrame({ fromSeq: 3, seq: 3 }, 10);

    expect(decision).toEqual({ action: "duplicate", nextSeq: 10 });
  });
});

describe("parseServerFrame", () => {
  test("accepts every frame the hub emits", () => {
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

  test("returns null for malformed JSON instead of throwing", () => {
    expect(parseServerFrame("{not json")).toBeNull();
    expect(parseServerFrame("")).toBeNull();
  });

  test("returns null for a shape the schema rejects", () => {
    // A version-mismatched server must not be able to push an unvalidated shape
    // into app state.
    expect(parseServerFrame(JSON.stringify({ nope: true }))).toBeNull();
    expect(
      parseServerFrame(JSON.stringify({ head: -1, type: "ready" }))
    ).toBeNull();
    // The snapshot is the client's entire resume path, so a preferences blob
    // missing a field is rejected rather than handed to the UI as `{}`.
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

  test("rejects a backwards range", () => {
    expect(
      parseServerFrame(JSON.stringify({ ...eventFrame(9, 5), fromSeq: 9 }))
    ).toBeNull();
  });
});

describe("resolveSocketUrl", () => {
  test("upgrades the origin and targets /ws", () => {
    expect(
      resolveSocketUrl({ isSecure: false, origin: "http://localhost:2000" })
    ).toBe("ws://localhost:2000/ws");
    expect(
      resolveSocketUrl({ isSecure: true, origin: "https://chorus.example" })
    ).toBe("wss://chorus.example/ws");
  });

  test("same-origin by default, so the session cookie rides the upgrade", () => {
    expect(
      resolveSocketUrl({ isSecure: true, origin: "https://app.example" })
    ).toBe("wss://app.example/ws");
  });

  test("an explicit override is honoured and any path is replaced", () => {
    expect(
      resolveSocketUrl({
        explicit: "http://127.0.0.1:2000/some/path",
        isSecure: false,
        origin: "https://app.example",
      })
    ).toBe("ws://127.0.0.1:2000/ws");
  });

  test("a query on the override is dropped so no stale ticket is reused", () => {
    expect(
      resolveSocketUrl({
        explicit: "http://127.0.0.1:2000/?ticket=old",
        isSecure: false,
        origin: "http://localhost:2000",
      })
    ).toBe("ws://127.0.0.1:2000/ws");
  });
});
