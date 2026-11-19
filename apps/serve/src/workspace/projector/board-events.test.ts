import { describe, expect, test } from "bun:test";
import { applyAgentEventToBoard } from "../projector";
import {
  agentEvent,
  column,
  makeBoard,
  makeTask,
  SESSION,
  stepsOf,
  T0,
} from "./test-support";

describe("board-events", () => {
  test("thinking moves the card into in_progress and records a step", () => {
    const board = makeBoard({
      columns: { queue: [makeTask()], in_progress: [], approve: [], done: [] },
    });

    const next = applyAgentEventToBoard(
      board,
      agentEvent({ activity: "thinking", partID: "p1", text: "pondering" })
    );

    expect(column(next, "in_progress")).toHaveLength(1);
    expect(column(next, "queue")).toHaveLength(0);
    expect(stepsOf(next)[0].kind).toBe("thinking");
    expect(stepsOf(next)[0].content).toBe("pondering");
  });

  test("a tool call lands in the step stream", () => {
    const next = applyAgentEventToBoard(
      makeBoard(),
      agentEvent({
        activity: "thinking",
        toolName: "read",
        toolState: "completed",
      })
    );

    expect(stepsOf(next)).toHaveLength(1);
    expect(stepsOf(next)[0].kind).toBe("tool_call");
    expect(stepsOf(next)[0].status).toBe("done");
  });

  test("waiting for approval routes the card to the approve lane", () => {
    const next = applyAgentEventToBoard(
      makeBoard(),
      agentEvent({ activity: "waiting_for_approval", permissionID: "perm-1" })
    );

    expect(column(next, "approve")).toHaveLength(1);
    expect(column(next, "in_progress")).toHaveLength(0);
    expect(stepsOf(next, "approve")[0].summary).toBe("Awaiting approval");
  });

  test("an idle session completes the card under auto review", () => {
    const next = applyAgentEventToBoard(
      makeBoard(),
      agentEvent({ activity: "idle", type: "session.idle" })
    );

    expect(column(next, "done")).toHaveLength(1);
    expect(next.session.currentTaskId).toBeUndefined();
    expect(next.session.state).toBe("active");
  });

  test("an idle session routes to approve under manual review and keeps the plan", () => {
    const board = makeBoard({
      reviewMode: "manual",
      columns: {
        queue: [],
        in_progress: [
          makeTask({
            run: {
              elapsed: "0m 00s",
              model: "claude",
              startedAt: T0,
              steps: [
                {
                  id: "s1",
                  kind: "response",
                  status: "done",
                  summary: "s",
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

    const next = applyAgentEventToBoard(
      board,
      agentEvent({ activity: "idle", type: "session.idle" })
    );

    expect(column(next, "approve")).toHaveLength(1);
    expect(column(next, "approve")[0].plan).toBe("the plan");
  });

  test("an error fails the card and marks the session errored", () => {
    const next = applyAgentEventToBoard(
      makeBoard(),
      agentEvent({
        activity: "error",
        type: "session.error",
        error: "exploded",
      })
    );

    expect(column(next, "done")).toHaveLength(1);
    expect(next.session.state).toBe("error");
    expect(next.session.errorMessage).toBe("exploded");
  });

  test("a timeout finishes the card without erroring the session", () => {
    const next = applyAgentEventToBoard(
      makeBoard(),
      agentEvent({
        activity: "error",
        type: "session.timeout",
        error: "no activity",
      })
    );

    expect(column(next, "done")).toHaveLength(1);
    expect(next.session.state).toBe("active");
    expect(next.session.errorMessage).toBe("no activity");

    expect(next.session.currentTaskId).toBeUndefined();
  });

  test("events for another session are ignored", () => {
    const board = makeBoard();
    expect(
      applyAgentEventToBoard(
        board,
        agentEvent({ activity: "thinking", partID: "p1", sessionID: "other" })
      )
    ).toBe(board);
  });

  test("events are ignored when the board has no active task", () => {
    const board = makeBoard({
      session: { sessionId: SESSION, state: "active" },
    });
    expect(
      applyAgentEventToBoard(
        board,
        agentEvent({ activity: "thinking", partID: "p1" })
      )
    ).toBe(board);
  });
});
