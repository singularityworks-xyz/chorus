import { describe, expect, test } from "bun:test";
import { applyEventToBoard } from "../projector";
import {
  BOARD,
  columnOf,
  laneOf,
  makeBoard,
  makeTask,
  T0,
  TASK,
} from "./test-support";

describe("session events", () => {
  test("session.starting flips the session state", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "session.starting",
      ts: T0,
      boardId: BOARD,
    });
    expect(next.session.state).toBe("starting");
  });

  test("session.attached binds the session id and clears prior errors", () => {
    const board = makeBoard({
      session: {
        currentTaskId: TASK,
        errorMessage: "old failure",
        sessionId: "sess-old",
        state: "error",
      },
    });

    const next = applyEventToBoard(board, {
      type: "session.attached",
      ts: T0,
      boardId: BOARD,
      sessionId: "sess-new",
      taskId: TASK,
    });

    expect(next.session.sessionId).toBe("sess-new");
    expect(next.session.state).toBe("active");
    expect(next.session.errorMessage).toBeUndefined();
    expect(columnOf(next, "in_progress")[0].runId).toBe("sess-new");
  });

  test("session.idle in auto review moves the card to done", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "session.idle",
      ts: T0,
      boardId: BOARD,
    });

    expect(laneOf(next, TASK)).toBe("done");
    expect(next.session.currentTaskId).toBeUndefined();
    expect(next.session.state).toBe("active");
    expect(columnOf(next, "done")[0]?.outcome).toBe("succeeded");
  });

  test("session.idle in manual review moves the card to approve and stores the plan", () => {
    const board = makeBoard({
      reviewMode: "auto",
      columns: {
        queue: [],
        in_progress: [
          makeTask({
            promptInput: { reviewMode: "manual", text: "Fix the bug" },
            run: {
              elapsed: "0m 00s",
              model: "claude",
              startedAt: T0,
              steps: [
                {
                  id: "s1",
                  kind: "response",
                  status: "done",
                  summary: "summary",
                  content: "the plan",
                },
              ],
              taskTitle: "Fix the bug",
            },
          }),
        ],
        approve: [],
        done: [],
      },
    });

    const next = applyEventToBoard(board, {
      type: "session.idle",
      ts: T0,
      boardId: BOARD,
    });

    expect(laneOf(next, TASK)).toBe("approve");
    expect(columnOf(next, "approve")[0].plan).toBe("the plan");
    expect(columnOf(next, "approve")[0].outcome).toBe("awaiting_review");
  });

  test("review mode changes during a run do not alter that task policy", () => {
    const board = makeBoard({
      reviewMode: "auto",
      columns: {
        queue: [],
        in_progress: [
          makeTask({
            promptInput: { reviewMode: "manual", text: "Fix the bug" },
          }),
        ],
        approve: [],
        done: [],
      },
    });

    const next = applyEventToBoard(board, {
      type: "session.idle",
      ts: T0,
      boardId: BOARD,
    });

    expect(laneOf(next, TASK)).toBe("approve");
    expect(columnOf(next, "approve")[0]?.outcome).toBe("awaiting_review");
  });

  test("legacy tasks use the board review mode when no task policy was saved", () => {
    const board = makeBoard({
      reviewMode: "manual",
      columns: {
        queue: [],
        in_progress: [makeTask()],
        approve: [],
        done: [],
      },
    });

    const next = applyEventToBoard(board, {
      type: "session.idle",
      ts: T0,
      boardId: BOARD,
    });

    expect(laneOf(next, TASK)).toBe("approve");
    expect(columnOf(next, "approve")[0]?.outcome).toBe("awaiting_review");
  });

  test("session.idle with no current task is a no-op", () => {
    const board = makeBoard({ session: { state: "active" } });
    expect(
      applyEventToBoard(board, { type: "session.idle", ts: T0, boardId: BOARD })
    ).toBe(board);
  });

  test("session.error moves the card to done and records the error", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "session.error",
      ts: T0,
      boardId: BOARD,
      error: "exploded",
    });

    expect(laneOf(next, TASK)).toBe("done");
    expect(next.session.state).toBe("error");
    expect(next.session.errorMessage).toBe("exploded");
    expect(next.session.currentTaskId).toBeUndefined();
    expect(columnOf(next, "done")[0]?.outcome).toBe("failed");
    expect(columnOf(next, "done")[0]?.errorMessage).toBe("exploded");
  });

  test("session.timeout moves the card to done but keeps the session state", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "session.timeout",
      ts: T0,
      boardId: BOARD,
      error: "no activity",
    });

    expect(laneOf(next, TASK)).toBe("done");
    expect(next.session.state).toBe("active");
    expect(next.session.errorMessage).toBe("no activity");
    expect(columnOf(next, "done")[0]?.outcome).toBe("timed_out");
    expect(columnOf(next, "done")[0]?.errorMessage).toBe("no activity");
  });
});
