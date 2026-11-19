import { describe, expect, test } from "bun:test";
import type { WorkspaceEvent } from "../events";
import { applyEventToBoard } from "../projector";
import { BOARD, columnOf, makeBoard, makeTask, T0, TASK } from "./test-support";

describe("purity", () => {
  test("does not mutate the input board", () => {
    const board = makeBoard();
    const before = structuredClone(board);

    applyEventToBoard(board, {
      type: "card.waiting_for_approval",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      kind: "permission",
    });

    expect(board).toEqual(before);
  });

  test("returns a new reference when the event applies", () => {
    const board = makeBoard();
    const next = applyEventToBoard(board, {
      type: "board.moved",
      ts: T0,
      boardId: BOARD,
      position: { x: 5, y: 6 },
    });

    expect(next).not.toBe(board);
    expect(next.position).toEqual({ x: 5, y: 6 });
  });

  test("returns the same reference for a no-op event", () => {
    const board = makeBoard();
    const next = applyEventToBoard(board, {
      type: "card.started",
      ts: T0,
      boardId: BOARD,
      taskId: "does-not-exist",
    });

    expect(next).toBe(board);
  });

  test("is deterministic — replaying an event twice yields the same board", () => {
    const board = makeBoard();
    const event: WorkspaceEvent = {
      type: "step.upserted",
      ts: T0 + 5000,
      boardId: BOARD,
      taskId: TASK,
      step: { id: "s1", kind: "thinking", status: "running", summary: "Think" },
    };

    const once = applyEventToBoard(board, event);
    const twice = applyEventToBoard(once, event);

    expect(structuredClone(once)).toEqual(structuredClone(twice));
  });

  test("derives elapsed from the event timestamp, not the wall clock", () => {
    const started = T0;
    const board = makeBoard({
      columns: {
        queue: [],
        in_progress: [
          makeTask({
            run: {
              elapsed: "0m 00s",
              model: "claude",
              startedAt: started,
              steps: [],
              taskTitle: "Fix the bug",
            },
          }),
        ],
        approve: [],
        done: [],
      },
    });

    const next = applyEventToBoard(board, {
      type: "step.upserted",
      ts: started + 65_000,
      boardId: BOARD,
      taskId: TASK,
      step: { id: "s1", kind: "thinking", status: "running", summary: "x" },
    });

    expect(columnOf(next, "in_progress")[0].run?.elapsed).toBe("1m 05s");
  });
});
