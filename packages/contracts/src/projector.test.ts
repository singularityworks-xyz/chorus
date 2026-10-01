import { describe, expect, test } from "bun:test";
import type { Task, WorkspaceBoard } from "./base";
import { workspaceBoardSchema } from "./base";
import type { WorkspaceColumnId, WorkspaceEvent } from "./events";
import {
  applyEventToBoard,
  applyEventToBoards,
  applyEventToWorkspace,
} from "./projector";

const T0 = 1_700_000_000_000;
const BOARD = "board-1";
const TASK = "task-1";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK,
    label: "repo",
    labelVariant: "info-light",
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
    session: { currentTaskId: TASK, sessionId: "sess-1", state: "active" },
    title: "Repo",
    ...overrides,
  });
}

function columnOf(board: WorkspaceBoard, columnId: string): Task[] {
  return (board.columns[columnId] ?? []) as Task[];
}

/** Local stand-in for the now-private `findTaskColumn`. */
function laneOf(
  board: WorkspaceBoard,
  taskId: string
): WorkspaceColumnId | null {
  for (const lane of ["queue", "in_progress", "approve", "done"] as const) {
    if (columnOf(board, lane).some((task) => task.id === taskId)) {
      return lane;
    }
  }
  return null;
}

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

describe("board scoping", () => {
  test("ignores an event addressed to a different board", () => {
    const board = makeBoard();
    const next = applyEventToBoard(board, {
      type: "board.moved",
      ts: T0,
      boardId: "board-other",
      position: { x: 99, y: 99 },
    });

    expect(next).toBe(board);
  });

  test("ignores workspace-scoped events", () => {
    const board = makeBoard();
    expect(
      applyEventToBoard(board, {
        type: "preference.speech_voice_set",
        ts: T0,
        voiceId: "hannah",
      })
    ).toBe(board);

    expect(
      applyEventToBoard(board, {
        type: "board.selected",
        ts: T0,
        boardId: BOARD,
      })
    ).toBe(board);
  });

  test("applyEventToBoards only replaces the addressed board", () => {
    const other = workspaceBoardSchema.parse({
      ...makeBoard(),
      boardId: "board-2",
    });
    const boards = [makeBoard(), other];

    const next = applyEventToBoards(boards, {
      type: "board.moved",
      ts: T0,
      boardId: BOARD,
      position: { x: 42, y: 42 },
    });

    expect(next[0].position).toEqual({ x: 42, y: 42 });
    expect(next[1]).toBe(other);
  });

  test("applyEventToBoards returns the same array when nothing changed", () => {
    const boards = [makeBoard()];
    expect(
      applyEventToBoards(boards, {
        type: "board.moved",
        ts: T0,
        boardId: "nobody",
        position: { x: 1, y: 1 },
      })
    ).toBe(boards);
  });
});

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

  test("board.task_plan_updated sets plan and questions", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "board.task_plan_updated",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
      plan: "step one",
      questions: ["which?"],
    });

    const task = columnOf(next, "in_progress")[0];
    expect(task.plan).toBe("step one");
    expect(task.questions).toEqual(["which?"]);
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

  test("card.completed moves to done and releases the session task", () => {
    const next = applyEventToBoard(makeBoard(), {
      type: "card.completed",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
    });

    expect(laneOf(next, TASK)).toBe("done");
    expect(next.session.currentTaskId).toBeUndefined();
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

  test("a step event lazily opens the run on a card that has none", () => {
    // Matches pre-Phase-1 behaviour: the first event opens `run` with a
    // placeholder model rather than requiring an explicit `run.started`.
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
  });

  test("session.idle in manual review moves the card to approve and stores the plan", () => {
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
  });
});

describe("workspace-scoped events", () => {
  const workspace = {
    boards: [makeBoard()],
    preferences: {
      boardViewMode: "relaxed" as const,
      composerHintDismissed: false,
      recentlyUsedModels: [],
      speechVoiceId: null,
    },
    selectedBoardId: null,
  };

  test("board.selected sets and clears the selection", () => {
    const selected = applyEventToWorkspace(workspace, {
      type: "board.selected",
      ts: T0,
      boardId: BOARD,
    });
    expect(selected.selectedBoardId).toBe(BOARD);

    const cleared = applyEventToWorkspace(selected, {
      type: "board.selected",
      ts: T0,
      boardId: null,
    });
    expect(cleared.selectedBoardId).toBeNull();
  });

  test("composer hint dismissal is recorded", () => {
    const next = applyEventToWorkspace(workspace, {
      type: "preference.composer_hint_dismissed",
      ts: T0,
    });
    expect(next.preferences.composerHintDismissed).toBe(true);
  });

  test("speech voice can be set and cleared", () => {
    const set = applyEventToWorkspace(workspace, {
      type: "preference.speech_voice_set",
      ts: T0,
      voiceId: "hannah",
    });
    expect(set.preferences.speechVoiceId).toBe("hannah");

    const cleared = applyEventToWorkspace(set, {
      type: "preference.speech_voice_set",
      ts: T0,
      voiceId: null,
    });
    expect(cleared.preferences.speechVoiceId).toBeNull();
  });

  test("board view mode switches", () => {
    const next = applyEventToWorkspace(workspace, {
      type: "preference.board_view_mode_set",
      ts: T0,
      mode: "stacked",
    });
    expect(next.preferences.boardViewMode).toBe("stacked");
  });

  test("recent models prepend and de-duplicate", () => {
    const first = applyEventToWorkspace(workspace, {
      type: "preference.recent_model_added",
      ts: T0,
      model: { providerID: "anthropic", modelID: "claude" },
    });
    expect(first.preferences.recentlyUsedModels).toHaveLength(1);

    const second = applyEventToWorkspace(first, {
      type: "preference.recent_model_added",
      ts: T0,
      model: { providerID: "openai", modelID: "gpt" },
    });
    expect(second.preferences.recentlyUsedModels.map((m) => m.modelID)).toEqual(
      ["gpt", "claude"]
    );

    const repeated = applyEventToWorkspace(second, {
      type: "preference.recent_model_added",
      ts: T0,
      model: { providerID: "anthropic", modelID: "claude" },
    });
    expect(repeated.preferences.recentlyUsedModels).toHaveLength(2);
  });

  test("board-scoped events leave the workspace untouched", () => {
    const next = applyEventToWorkspace(workspace, {
      type: "card.started",
      ts: T0,
      boardId: BOARD,
      taskId: TASK,
    });
    expect(next).toBe(workspace);
  });
});

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

    // file_edit steps are excluded from plan text; response/thinking are joined
    expect(columnOf(next, "approve")[0].plan).toBe("one\n\ntwo");
  });

  test("a manual-review idle with no prose yields no plan", () => {
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
