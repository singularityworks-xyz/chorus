import { describe, expect, test } from "bun:test";
import { applyEventToBoard } from "../projector";
import { BOARD, columnOf, makeBoard, makeTask, T0, TASK } from "./test-support";

describe("formatting via the public API", () => {
  function elapsedAfter(ts: number): string | undefined {
    const board = makeBoard();
    const next = applyEventToBoard(board, {
      type: "run.started",
      ts,
      boardId: BOARD,
      taskId: TASK,
      model: "claude",
      startedAt: T0,
      taskTitle: "Fix the bug",
    });
    return columnOf(next, "in_progress")[0].run?.elapsed;
  }

  test("elapsed is formatted from the event timestamp", () => {
    expect(elapsedAfter(T0)).toBe("0m 00s");
    expect(elapsedAfter(T0 + 5000)).toBe("0m 05s");
    expect(elapsedAfter(T0 + 125_000)).toBe("2m 05s");
  });

  test("negative clock drift clamps to zero", () => {
    expect(elapsedAfter(T0 - 10_000)).toBe("0m 00s");
  });

  test("a manual-review idle extracts the plan from response content", () => {
    const board = makeBoard({
      reviewMode: "manual",
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
                  id: "a",
                  kind: "thinking",
                  status: "done",
                  summary: "s",
                  content: "one",
                },
                { id: "b", kind: "file_edit", status: "done", summary: "edit" },
                {
                  id: "c",
                  kind: "response",
                  status: "done",
                  summary: "s",
                  content: "two",
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
    expect(columnOf(next, "approve")[0].plan).toBe("one\n\ntwo");
  });

  test("a manual-review idle with no prose yields no plan", () => {
    const board = makeBoard({
      reviewMode: "manual",
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
                { id: "b", kind: "file_edit", status: "done", summary: "edit" },
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

    expect(columnOf(next, "approve")[0].plan).toBeUndefined();
  });
});
