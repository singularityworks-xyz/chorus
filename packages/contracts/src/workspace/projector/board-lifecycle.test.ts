import { describe, expect, test } from "bun:test";
import { applyEventToBoard } from "../projector";
import { BOARD, columnOf, makeBoard, makeTask, T0, TASK } from "./test-support";

describe("board lifecycle events", () => {
  test("board.review_mode_set flips manual review", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "board.review_mode_set",
      ts: T0,
      boardId: BOARD,
      reviewMode: "manual",
    });
    expect(next.reviewMode).toBe("manual");
  });

  test("board.model_set stores and clears the model", () => {
    const set = applyEventToBoard(makeBoard(), {
      type: "board.model_set",
      ts: T0,
      boardId: BOARD,
      model: { providerID: "anthropic", modelID: "claude" },
    });
    expect(set.modelSelection?.modelID).toBe("claude");

    const cleared = applyEventToBoard(set, {
      type: "board.model_set",
      ts: T0,
      boardId: BOARD,
      model: null,
    });
    expect(cleared.modelSelection).toBeNull();
  });

  test("board.session_patched merges without dropping other fields", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "board.session_patched",
      ts: T0,
      boardId: BOARD,
      session: { state: "error" },
    });

    expect(next.session.state).toBe("error");
    expect(next.session.sessionId).toBe("sess-1");
    expect(next.session.currentTaskId).toBe(TASK);
  });

  test("board.columns_replaced normalizes missing lanes", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "board.columns_replaced",
      ts: T0,
      boardId: BOARD,
      columns: { queue: [makeTask()] },
    });

    expect(columnOf(next, "queue")).toHaveLength(1);
    expect(columnOf(next, "in_progress")).toHaveLength(0);
    expect(columnOf(next, "approve")).toHaveLength(0);
    expect(columnOf(next, "done")).toHaveLength(0);
  });

  test("card.reordered moves a task before its lane anchor", () => {
    const taskA = makeTask({ id: "task-a" });
    const taskB = makeTask({ id: "task-b" });
    const taskC = makeTask({ id: "task-c" });
    const board = makeBoard({
      columns: {
        queue: [taskA, taskB, taskC],
        in_progress: [],
        approve: [],
        done: [],
      },
    });

    const next = applyEventToBoard(board, {
      type: "card.reordered",
      ts: T0,
      boardId: BOARD,
      taskId: "task-c",
      column: "queue",
      beforeTaskId: "task-a",
    });

    expect(columnOf(next, "queue").map((task) => task.id)).toEqual([
      "task-c",
      "task-a",
      "task-b",
    ]);
  });

  test("card.reordered ignores tasks that have left the source lane", () => {
    const board = makeBoard({
      columns: {
        queue: [makeTask({ id: "task-b" })],
        in_progress: [makeTask({ id: TASK })],
        approve: [],
        done: [],
      },
    });

    const next = applyEventToBoard(board, {
      type: "card.reordered",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      column: "queue",
      beforeTaskId: "task-b",
    });

    expect(next).toBe(board);
  });

  test("board.task_plan_updated sets plan and questions", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "board.task_plan_updated",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      plan: "step one",
      questions: ["which?"],
      questionAnswers: ["option A"],
      reviewApproved: true,
      errorMessage: null,
    });

    const task = columnOf(next, "in_progress")[0];
    expect(task.plan).toBe("step one");
    expect(task.questions).toEqual(["which?"]);
    expect(task.questionAnswers).toEqual(["option A"]);
    expect(task.reviewApproved).toBe(true);
    expect(task.errorMessage).toBeUndefined();
  });

  test("board.created and board.removed do not mutate an existing board", () => {
    const board = makeBoard();
    expect(
      applyEventToBoard(board, {
        type: "board.created",
        ts: T0,
        boardId: BOARD,
        board,
      })
    ).toBe(board);
    expect(
      applyEventToBoard(board, {
        type: "board.removed",
        ts: T0,
        boardId: BOARD,
      })
    ).toBe(board);
  });
});
