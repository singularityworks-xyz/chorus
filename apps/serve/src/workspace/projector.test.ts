import { describe, expect, test } from "bun:test";
import type { Task, WorkspaceBoard } from "@chorus/contracts";
import { applyEventToBoard, workspaceBoardSchema } from "@chorus/contracts";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import {
  applyAgentEventToBoard,
  attachSessionToBoard,
  toWorkspaceEvents,
} from "./projector";

const T0 = 1_700_000_000_000;
const BOARD = "board-1";
const SESSION = "sess-1";
const TASK = "task-1";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK,
    label: "repo",
    labelVariant: "primary-light",
    title: "Fix the bug",
    ...overrides,
  };
}

function makeBoard(overrides: Partial<WorkspaceBoard> = {}): WorkspaceBoard {
  return workspaceBoardSchema.parse({
    boardId: BOARD,
    columns: {
      queue: [],
      in_progress: [makeTask()],
      approve: [],
      done: [],
    },
    modelSelection: null,
    position: { x: 0, y: 0 },
    repo: { directory: "/tmp/repo", worktree: "/tmp/repo" },
    reviewMode: "auto",
    session: { currentTaskId: TASK, sessionId: SESSION, state: "active" },
    title: "Repo",
    ...overrides,
  });
}

function agentEvent(
  overrides: Partial<NormalizedAgentEvent>
): NormalizedAgentEvent {
  return {
    sessionID: SESSION,
    timestamp: T0,
    type: "message.part.updated",
    ...overrides,
  };
}

function column(board: WorkspaceBoard, columnId: string): Task[] {
  return (board.columns[columnId] ?? []) as Task[];
}

function stepsOf(board: WorkspaceBoard, columnId = "in_progress") {
  return column(board, columnId)[0]?.run?.steps ?? [];
}

describe("agent event normalization", () => {
  test("a thinking event yields a step and an in_progress move", () => {
    const events = toWorkspaceEvents(
      agentEvent({ activity: "thinking", partID: "p1", text: "pondering" }),
      { boardId: BOARD, taskId: TASK }
    );

    expect(events.map((e) => e.type)).toEqual([
      "step.upserted",
      "card.started",
    ]);
  });

  test("a tool event becomes a tool_call step", () => {
    const [step] = toWorkspaceEvents(
      agentEvent({
        activity: "idle",
        toolName: "bash",
        toolState: "completed",
        partID: "p2",
      }),
      { boardId: BOARD, taskId: TASK }
    );

    expect(step.type).toBe("step.upserted");
    expect(step.type === "step.upserted" && step.step.kind).toBe("tool_call");
    expect(step.type === "step.upserted" && step.step.summary).toBe(
      "bash · completed"
    );
  });

  test("a file diff downgrades the step to file_edit with contents", () => {
    const [step] = toWorkspaceEvents(
      agentEvent({
        activity: "idle",
        toolName: "edit",
        partID: "p3",
        fileDiff: {
          additions: 3,
          after: "after",
          before: "before",
          deletions: 1,
          filePath: "src/app.ts",
        },
      }),
      { boardId: BOARD, taskId: TASK }
    );

    expect(step.type === "step.upserted" && step.step.kind).toBe("file_edit");
    expect(step.type === "step.upserted" && step.step.filePath).toBe(
      "src/app.ts"
    );
    expect(step.type === "step.upserted" && step.step.originalContent).toBe(
      "before"
    );
    expect(step.type === "step.upserted" && step.step.linesAdded).toBe(3);
  });

  test("a permission request is normalized to a permission approval", () => {
    const events = toWorkspaceEvents(
      agentEvent({
        activity: "waiting_for_approval",
        permissionID: "perm-1",
      }),
      { boardId: BOARD, taskId: TASK }
    );

    const approval = events.find((e) => e.type === "card.waiting_for_approval");
    expect(approval).toBeDefined();
    expect(
      approval?.type === "card.waiting_for_approval" && approval.kind
    ).toBe("permission");
    expect(
      approval?.type === "card.waiting_for_approval" && approval.requestId
    ).toBe("perm-1");
  });

  test("an agent question is normalized to a question approval", () => {
    const events = toWorkspaceEvents(
      agentEvent({
        activity: "waiting_for_question",
        questionID: "q-1",
        questions: [
          { header: "Which approach?", options: [], question: "Which one?" },
        ],
      }),
      { boardId: BOARD, taskId: TASK }
    );

    const approval = events.find((e) => e.type === "card.waiting_for_approval");
    expect(
      approval?.type === "card.waiting_for_approval" && approval.kind
    ).toBe("question");
  });

  test("a timeout maps to session.timeout, not session.error", () => {
    const events = toWorkspaceEvents(
      agentEvent({
        activity: "error",
        type: "session.timeout",
        error: "no activity",
      }),
      { boardId: BOARD, taskId: TASK }
    );

    expect(events.some((e) => e.type === "session.timeout")).toBe(true);
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  });

  test("every emitted event carries the board scope", () => {
    const events = toWorkspaceEvents(
      agentEvent({ activity: "thinking", partID: "p9", text: "x" }),
      { boardId: "board-xyz", taskId: "task-xyz" }
    );

    for (const event of events) {
      expect("boardId" in event && event.boardId).toBe("board-xyz");
    }
  });
});

describe("agent events applied to a board", () => {
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

describe("streamed deltas", () => {
  const scope = { boardId: BOARD, taskId: TASK };

  function applyDomainEvents(
    board: WorkspaceBoard,
    events: ReturnType<typeof toWorkspaceEvents>
  ): WorkspaceBoard {
    return events.reduce(applyEventToBoard, board);
  }

  /** Opens a part-scoped response step and seeds `content` into it. */
  function boardWithStreamingStep(content: string) {
    const board = makeBoard();
    const opened = applyDomainEvents(
      board,
      toWorkspaceEvents(
        agentEvent({
          activity: "writing",
          partID: "prt_1",
          messageID: "msg_1",
        }),
        scope
      )
    );
    return applyDomainEvents(
      opened,
      toWorkspaceEvents(
        agentEvent({
          activity: "writing",
          delta: content,
          messageID: "msg_1",
          partID: "prt_1",
        }),
        scope
      )
    );
  }

  test("appends a delta to the matching part step", () => {
    const board = boardWithStreamingStep("he");
    const next = applyAgentEventToBoard(
      board,
      agentEvent({
        activity: "writing",
        delta: "llo",
        messageID: "msg_1",
        partID: "prt_1",
      })
    );

    expect(stepsOf(next)).toHaveLength(1);
    expect(stepsOf(next)[0].content).toBe("hello");
    expect(stepsOf(next)[0].summary).toBe("hello");
  });

  test("does not leak deltas between different parts", () => {
    const board = boardWithStreamingStep("first");

    const withTwo = applyDomainEvents(
      board,
      toWorkspaceEvents(
        agentEvent({
          activity: "writing",
          partID: "prt_2",
          messageID: "msg_2",
        }),
        scope
      )
    );
    expect(stepsOf(withTwo)).toHaveLength(2);

    const appended = applyAgentEventToBoard(
      withTwo,
      agentEvent({
        activity: "writing",
        delta: "second",
        messageID: "msg_2",
        partID: "prt_2",
      })
    );

    expect(stepsOf(appended)).toHaveLength(2);
    expect(stepsOf(appended)[0].content).toBe("first");
    expect(stepsOf(appended)[1].content).toBe("second");
  });

  test("a delta with no matching step opens one instead of dropping text", () => {
    const board = makeBoard();
    const next = applyAgentEventToBoard(
      board,
      agentEvent({ activity: "writing", delta: "orphan tokens" })
    );

    expect(stepsOf(next)).toHaveLength(1);
    expect(stepsOf(next)[0].content).toBe("orphan tokens");
  });

  test("step ids are stable across the stream", () => {
    const board = boardWithStreamingStep("a");
    const ids = stepsOf(board).map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("attachSessionToBoard", () => {
  test("binds the session id and clears a prior error", () => {
    const board = makeBoard({
      session: {
        currentTaskId: TASK,
        errorMessage: "old",
        sessionId: "sess-old",
        state: "error",
      },
    });

    const next = attachSessionToBoard(board, "sess-new");

    expect(next.session.sessionId).toBe("sess-new");
    expect(next.session.state).toBe("active");
    expect(next.session.errorMessage).toBeUndefined();
    expect(column(next, "in_progress")[0].runId).toBe("sess-new");
  });

  test("works on a board with no active task", () => {
    const board = makeBoard({ session: { state: "uninitialized" } });
    const next = attachSessionToBoard(board, "sess-new");

    expect(next.session.sessionId).toBe("sess-new");
    expect(next.session.state).toBe("active");
  });
});
