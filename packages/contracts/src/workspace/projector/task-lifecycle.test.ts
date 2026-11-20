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

describe("card lifecycle events", () => {
  test("card.created appends to the named lane and claims the session task", () => {
    const board = makeBoard({
      columns: { queue: [], in_progress: [], approve: [], done: [] },
      session: { state: "active" },
    });

    const next = applyEventToBoard(board, {
      type: "card.created",
      ts: T0,
      boardId: BOARD,
      column: "queue",
      taskId: "task-2",
      task: {
        id: "task-2",
        label: "repo",
        labelVariant: "info-light",
        title: "New",
      },
    });

    expect(columnOf(next, "queue")).toHaveLength(1);
    expect(columnOf(next, "queue")[0].labelVariant).toBe("info-light");
    expect(next.session.currentTaskId).toBe("task-2");
  });

  test("card.queued moves the card to queue", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "card.queued",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      column: "queue",
    });

    expect(laneOf(next, TASK)).toBe("queue");
  });

  test("card.started moves the card to in_progress and relabels it", () => {
    const queued = makeBoard({
      columns: {
        queue: [makeTask()],
        in_progress: [],
        approve: [],
        done: [],
      },
    });

    const next = applyEventToBoard(queued, {
      type: "card.started",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
    });

    expect(laneOf(next, TASK)).toBe("in_progress");
    expect(columnOf(next, "queue")).toHaveLength(0);
    expect(columnOf(next, "in_progress")[0].labelVariant).toBe("primary-light");
  });

  test("card.moved honours an explicit lane", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "card.moved",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      column: "done",
    });

    expect(laneOf(next, TASK)).toBe("done");
  });

  test("card.waiting_for_approval routes to approve for both request kinds", () => {
    for (const kind of ["permission", "question"] as const) {
      const next = applyEventToBoard(makeBoard(), {
        type: "card.waiting_for_approval",
        ts: T0,
        boardId: BOARD,
        taskId: TASK,
        kind,
      });

      expect(laneOf(next, TASK)).toBe("approve");
      expect(columnOf(next, "approve")[0].labelVariant).toBe("warning-light");
    }
  });

  test("pending request descriptors survive resume until the request is resolved", () => {
    const waiting = applyEventToBoard(makeBoard(), {
      boardId: BOARD,
      kind: "question",
      pendingApproval: {
        kind: "question",
        requestId: "question-1",
        questions: [
          {
            header: "Scope",
            question: "Which package should change?",
            options: [{ label: "web", description: "Frontend package" }],
          },
        ],
      },
      requestId: "question-1",
      taskId: TASK,
      ts: T0,
      type: "card.waiting_for_approval",
    });
    const pending = columnOf(waiting, "approve")[0]?.pendingApproval;
    expect(pending?.kind).toBe("question");
    if (pending?.kind === "question") {
      expect(pending.questions[0]?.question).toBe(
        "Which package should change?"
      );
    }

    const resumed = applyEventToBoard(waiting, {
      boardId: BOARD,
      taskId: TASK,
      ts: T0 + 1,
      type: "card.started",
    });
    expect(
      columnOf(resumed, "in_progress")[0]?.pendingApproval?.requestId
    ).toBe("question-1");

    const resolved = applyEventToBoard(resumed, {
      boardId: BOARD,
      requestId: "question-1",
      taskId: TASK,
      ts: T0 + 2,
      type: "card.approval_resolved",
    });
    expect(
      columnOf(resolved, "in_progress")[0]?.pendingApproval
    ).toBeUndefined();
    expect(columnOf(resolved, "in_progress")[0]?.pendingApprovals).toEqual([]);
  });

  test("resolving one request preserves other pending requests", () => {
    const permission = applyEventToBoard(makeBoard(), {
      boardId: BOARD,
      kind: "permission",
      pendingApproval: {
        kind: "permission",
        permission: "write",
        requestId: "permission-1",
      },
      requestId: "permission-1",
      taskId: TASK,
      ts: T0,
      type: "card.waiting_for_approval",
    });
    const question = applyEventToBoard(permission, {
      boardId: BOARD,
      kind: "question",
      pendingApproval: {
        kind: "question",
        requestId: "question-1",
        questions: [],
      },
      requestId: "question-1",
      taskId: TASK,
      ts: T0 + 1,
      type: "card.waiting_for_approval",
    });
    const resolved = applyEventToBoard(question, {
      boardId: BOARD,
      requestId: "permission-1",
      taskId: TASK,
      ts: T0 + 2,
      type: "card.approval_resolved",
    });
    expect(
      columnOf(resolved, "approve")[0]?.pendingApprovals?.map(
        (entry) => entry.requestId
      )
    ).toEqual(["question-1"]);
    expect(columnOf(resolved, "approve")[0]?.pendingApproval?.requestId).toBe(
      "question-1"
    );
  });

  test("card.completed moves to done and releases the session task", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "card.completed",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
    });

    expect(laneOf(next, TASK)).toBe("done");
    expect(next.session.currentTaskId).toBeUndefined();
    expect(columnOf(next, "done")[0]?.outcome).toBe("succeeded");
  });

  test("card.failed moves to done and marks the session errored", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "card.failed",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      error: "boom",
    });

    expect(laneOf(next, TASK)).toBe("done");
    expect(next.session.state).toBe("error");
    expect(next.session.errorMessage).toBe("boom");
    expect(columnOf(next, "done")[0]?.outcome).toBe("failed");
    expect(columnOf(next, "done")[0]?.errorMessage).toBe("boom");
  });

  test("card.aborted moves a rejected plan to done and releases the task", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "card.aborted",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      reason: "Plan rejected",
    });

    expect(laneOf(next, TASK)).toBe("done");
    expect(next.session.currentTaskId).toBeUndefined();
    expect(columnOf(next, "done")[0]?.outcome).toBe("aborted");
  });

  test("moves are idempotent — re-applying a move is a no-op", () => {
    const first = applyEventToBoard(makeBoard(), {
      type: "card.started",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
    });
    const second = applyEventToBoard(first, {
      type: "card.started",
      ts: T0 + 1,
      boardId: BOARD,
      taskId: TASK,
    });

    expect(second).toBe(first);
    expect(columnOf(second, "in_progress")).toHaveLength(1);
  });

  test("moving an unknown card changes nothing", () => {
    const board = makeBoard();
    expect(
      applyEventToBoard(board, {
        type: "card.started",
        ts: T0,
        boardId: BOARD,
        taskId: "ghost",
      })
    ).toBe(board);
  });
});
