import { describe, expect, test } from "bun:test";
import type { WorkspaceBoard } from "../base/boards";
import { workspaceBoardSchema } from "../base/boards";
import { applyEventToBoard } from "../projector";
import { BOARD, columnOf, makeBoard, makeTask, T0, TASK } from "./test-support";

describe("run and step events", () => {
  function boardWithRun(steps: WorkspaceBoard["columns"]["queue"]) {
    return makeBoard({
      columns: {
        queue: [],
        in_progress: [
          makeTask({
            run: {
              elapsed: "0m 00s",
              model: "claude",
              sessionId: "sess-1",
              startedAt: T0,
              steps: steps as never,
              taskTitle: "Fix the bug",
            },
          }),
        ],
        approve: [],
        done: [],
      },
    });
  }

  test("run.started seeds the run and activates the session", () => {
    const board = makeBoard({
      session: { state: "uninitialized" },
    });

    const next = applyEventToBoard(board, {
      type: "run.started",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      model: "claude",
      sessionId: "sess-1",
      startedAt: T0,
      taskTitle: "Fix the bug",
    });

    const task = columnOf(next, "in_progress")[0];
    expect(task.run?.model).toBe("claude");
    expect(task.run?.startedAt).toBe(T0);
    expect(task.run?.elapsed).toBe("0m 00s");
    expect(next.session.state).toBe("active");
    expect(next.session.sessionId).toBe("sess-1");
    expect(next.session.currentTaskId).toBe(TASK);
  });

  test("step.upserted appends a step and closes the previous running one", () => {
    const board = boardWithRun([
      { id: "s1", kind: "thinking", status: "running", summary: "a" },
    ]);

    const next = applyEventToBoard(board, {
      type: "step.upserted",
      ts: T0 + 1000,
      boardId: BOARD,
      taskId: TASK,
      step: { id: "s2", kind: "response", status: "running", summary: "b" },
    });

    const steps = columnOf(next, "in_progress")[0].run?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps[0].status).toBe("done");
    expect(steps[1].id).toBe("s2");
  });

  test("step.upserted with an existing id replaces in place", () => {
    const board = boardWithRun([
      { id: "s1", kind: "thinking", status: "running", summary: "a" },
    ]);

    const next = applyEventToBoard(board, {
      type: "step.upserted",
      ts: T0 + 1000,
      boardId: BOARD,
      taskId: TASK,
      step: { id: "s1", kind: "thinking", status: "done", summary: "done" },
    });

    const steps = columnOf(next, "in_progress")[0].run?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("done");
  });

  test("step.upserted does not re-key step ids", () => {
    const board = boardWithRun([]);
    const next = applyEventToBoard(board, {
      type: "step.upserted",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      step: {
        id: "part-abc",
        kind: "response",
        status: "running",
        summary: "x",
      },
    });

    expect(columnOf(next, "in_progress")[0].run?.steps[0].id).toBe("part-abc");
  });

  test("step.delta_appended appends to the target step", () => {
    const board = boardWithRun([
      {
        id: "part-abc",
        kind: "response",
        status: "running",
        summary: "a",
        content: "he",
      },
    ]);

    const next = applyEventToBoard(board, {
      type: "step.delta_appended",
      ts: T0 + 10,
      boardId: BOARD,
      taskId: TASK,
      stepId: "part-abc",
      delta: "llo",
    });

    const step = columnOf(next, "in_progress")[0].run?.steps[0];
    expect(step?.content).toBe("hello");
    expect(step?.summary).toBe("hello");
  });

  test("step.delta_appended for an unknown step is a no-op", () => {
    const board = boardWithRun([
      { id: "part-abc", kind: "response", status: "running", summary: "a" },
    ]);

    const next = applyEventToBoard(board, {
      type: "step.delta_appended",
      ts: T0 + 10,
      boardId: BOARD,
      taskId: TASK,
      stepId: "part-missing",
      delta: "text",
    });

    expect(
      columnOf(next, "in_progress")[0].run?.steps[0].content
    ).toBeUndefined();
  });

  test("an empty first delta still creates a schema-valid step", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "step.delta_appended",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      stepId: "empty-part",
      delta: "",
    });

    const parsed = workspaceBoardSchema.safeParse(next);
    expect(parsed.success).toBe(true);
    expect(columnOf(next, "in_progress")[0].run?.steps[0]?.summary).toBe(
      "Streaming response"
    );
  });

  test("a step event lazily opens the run on a card that has none", () => {
    const board = makeBoard();
    expect(columnOf(board, "in_progress")[0].run).toBeUndefined();

    const next = applyEventToBoard(board, {
      type: "step.upserted",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      step: { id: "s1", kind: "thinking", status: "running", summary: "x" },
    });

    const run = columnOf(next, "in_progress")[0].run;
    expect(run).toBeDefined();
    expect(run?.steps).toHaveLength(1);
    expect(run?.startedAt).toBe(T0);
  });

  test("a delta for a card with no run opens the run and keeps the text", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "step.delta_appended",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      stepId: "s1",
      delta: "tokens",
    });

    const run = columnOf(next, "in_progress")[0].run;
    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0].content).toBe("tokens");
  });
});
