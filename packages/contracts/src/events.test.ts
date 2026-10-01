import { describe, expect, test } from "bun:test";
import { agentStepSchema, workspaceBoardSchema } from "./base";
import type { WorkspaceEvent } from "./events";
import {
  boardCreatedEventSchema,
  isBoardScopedEvent,
  WORKSPACE_SNAPSHOT_VERSION,
  workspaceEventSchema,
} from "./events";
import {
  createVersionedSnapshot,
  isCoalescibleEvent,
  isControlEvent,
  MAX_REPLAY_GAP,
  sequencedEventSchema,
  serverMessageSchema,
  snapshotMessageSchema,
  WS_CLOSE_RATE_LIMITED,
  WS_CLOSE_UNAUTHORIZED,
} from "./protocol";

const TS = 1_700_000_000_000;

const board = workspaceBoardSchema.parse({
  boardId: "board-1",
  columns: { queue: [], in_progress: [], approve: [], done: [] },
  modelSelection: null,
  position: { x: 10, y: 20 },
  repo: { directory: "/tmp/repo", worktree: "/tmp/repo" },
  reviewMode: "auto",
  session: { state: "active" },
  title: "Repo",
});

const step = agentStepSchema.parse({
  id: "step-1",
  kind: "thinking",
  status: "running",
  summary: "Thinking",
});

/** Every event variant, keyed by discriminator — the round-trip corpus. */
const EVENT_CORPUS: Record<WorkspaceEvent["type"], WorkspaceEvent> = {
  "board.created": { type: "board.created", ts: TS, boardId: "board-1", board },
  "board.moved": {
    type: "board.moved",
    ts: TS,
    boardId: "board-1",
    position: { x: 1, y: 2 },
  },
  "board.removed": { type: "board.removed", ts: TS, boardId: "board-1" },
  "board.selected": { type: "board.selected", ts: TS, boardId: "board-1" },
  "board.review_mode_set": {
    type: "board.review_mode_set",
    ts: TS,
    boardId: "board-1",
    reviewMode: "manual",
  },
  "board.model_set": {
    type: "board.model_set",
    ts: TS,
    boardId: "board-1",
    model: { providerID: "anthropic", modelID: "claude" },
  },
  "board.columns_replaced": {
    type: "board.columns_replaced",
    ts: TS,
    boardId: "board-1",
    columns: { queue: [], in_progress: [], approve: [], done: [] },
  },
  "board.session_patched": {
    type: "board.session_patched",
    ts: TS,
    boardId: "board-1",
    session: { state: "starting" },
  },
  "board.task_plan_updated": {
    type: "board.task_plan_updated",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    plan: "do the thing",
    questions: ["which one?"],
  },
  "card.created": {
    type: "card.created",
    ts: TS,
    boardId: "board-1",
    column: "queue",
    taskId: "task-1",
    task: {
      id: "task-1",
      label: "repo",
      labelVariant: "info-light",
      title: "Fix the bug",
    },
  },
  "card.queued": {
    type: "card.queued",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    column: "queue",
  },
  "card.started": {
    type: "card.started",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
  },
  "card.moved": {
    type: "card.moved",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    column: "approve",
  },
  "card.waiting_for_approval": {
    type: "card.waiting_for_approval",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    kind: "permission",
    requestId: "perm-1",
  },
  "card.completed": {
    type: "card.completed",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
  },
  "card.failed": {
    type: "card.failed",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    error: "boom",
  },
  "run.started": {
    type: "run.started",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    model: "claude",
    sessionId: "sess-1",
    startedAt: TS,
    taskTitle: "Fix the bug",
  },
  "step.upserted": {
    type: "step.upserted",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    step,
  },
  "step.delta_appended": {
    type: "step.delta_appended",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    stepId: "step-1",
    delta: "more text",
  },
  "session.attached": {
    type: "session.attached",
    ts: TS,
    boardId: "board-1",
    sessionId: "sess-1",
    taskId: "task-1",
  },
  "session.starting": { type: "session.starting", ts: TS, boardId: "board-1" },
  "session.idle": { type: "session.idle", ts: TS, boardId: "board-1" },
  "session.error": {
    type: "session.error",
    ts: TS,
    boardId: "board-1",
    error: "exploded",
  },
  "session.timeout": {
    type: "session.timeout",
    ts: TS,
    boardId: "board-1",
    error: "timed out",
  },
  "preference.recent_model_added": {
    type: "preference.recent_model_added",
    ts: TS,
    model: { providerID: "anthropic", modelID: "claude" },
  },
  "preference.composer_hint_dismissed": {
    type: "preference.composer_hint_dismissed",
    ts: TS,
  },
  "preference.speech_voice_set": {
    type: "preference.speech_voice_set",
    ts: TS,
    voiceId: "hannah",
  },
  "preference.board_view_mode_set": {
    type: "preference.board_view_mode_set",
    ts: TS,
    mode: "stacked",
  },
};

const ALL_TYPES = Object.keys(EVENT_CORPUS) as WorkspaceEvent["type"][];

describe("WorkspaceEvent round-trip", () => {
  test("the corpus covers every discriminator the union declares", () => {
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length);
    expect(ALL_TYPES.length).toBeGreaterThanOrEqual(28);
  });

  for (const type of ALL_TYPES) {
    test(`${type} survives parse -> serialize -> parse`, () => {
      const original = EVENT_CORPUS[type];
      const parsed = workspaceEventSchema.parse(original);
      expect(parsed).toEqual(original);

      const roundTripped = workspaceEventSchema.parse(
        JSON.parse(JSON.stringify(parsed))
      );
      expect(roundTripped).toEqual(original);
    });
  }

  test("rejects an unknown discriminator", () => {
    expect(() =>
      workspaceEventSchema.parse({ type: "board.teleported", ts: TS })
    ).toThrow();
  });

  test("rejects an event with no discriminator", () => {
    expect(() => workspaceEventSchema.parse({ ts: TS })).toThrow();
  });

  test("rejects an event missing its timestamp", () => {
    const { ts: _ts, ...withoutTs } = EVENT_CORPUS["board.moved"];
    expect(() => workspaceEventSchema.parse(withoutTs)).toThrow();
  });

  test("rejects a negative timestamp", () => {
    expect(() =>
      workspaceEventSchema.parse({
        type: "board.removed",
        ts: -1,
        boardId: "b",
      })
    ).toThrow();
  });

  test("rejects an empty boardId", () => {
    expect(() =>
      workspaceEventSchema.parse({ type: "board.removed", ts: TS, boardId: "" })
    ).toThrow();
  });

  test("rejects an unknown approval request kind", () => {
    expect(() =>
      workspaceEventSchema.parse({
        type: "card.waiting_for_approval",
        ts: TS,
        boardId: "board-1",
        taskId: "task-1",
        kind: "telepathy",
      })
    ).toThrow();
  });

  test("rejects a board.created event whose board fails its own schema", () => {
    expect(() =>
      boardCreatedEventSchema.parse({
        type: "board.created",
        ts: TS,
        boardId: "board-1",
        board: { boardId: "" },
      })
    ).toThrow();
  });
});

describe("board scoping", () => {
  test("board-scoped events report a boardId", () => {
    expect(isBoardScopedEvent(EVENT_CORPUS["board.moved"])).toBe(true);
    expect(isBoardScopedEvent(EVENT_CORPUS["card.started"])).toBe(true);
  });

  test("preference events are not board scoped", () => {
    expect(
      isBoardScopedEvent(EVENT_CORPUS["preference.speech_voice_set"])
    ).toBe(false);
  });

  test("deselecting is workspace scoped even though it names a board", () => {
    expect(
      isBoardScopedEvent({ type: "board.selected", ts: TS, boardId: null })
    ).toBe(false);
  });
});

describe("control vs coalescible events", () => {
  /**
   * The two types allowed to be batched. Everything else MUST be control, so an
   * event added later without updating `COALESCIBLE_EVENT_TYPES` is delivered
   * immediately instead of becoming droppable under backpressure.
   */
  const EXPECTED_COALESCIBLE: WorkspaceEvent["type"][] = [
    "step.upserted",
    "step.delta_appended",
  ];

  test("exactly the step events are coalescible", () => {
    const coalescible = ALL_TYPES.filter((type) =>
      isCoalescibleEvent(EVENT_CORPUS[type])
    );

    expect(coalescible.sort()).toEqual([...EXPECTED_COALESCIBLE].sort());
  });

  test("every non-coalescible event is classified as control", () => {
    // This is the table that actually protects Phase 3. It previously asserted
    // only that the two predicates disagreed — which is arithmetic, since
    // isCoalescibleEvent is defined as !isControlEvent, so it could never fail.
    const control = ALL_TYPES.filter((type) =>
      isControlEvent(EVENT_CORPUS[type])
    );

    expect(control.sort()).toEqual(
      ALL_TYPES.filter((t) => !EXPECTED_COALESCIBLE.includes(t)).sort()
    );
  });

  test("run.started is a control event, not batchable", () => {
    // It flips session.state to active and binds currentTaskId. Batched or
    // dropped, the card renders stuck with no run.
    expect(isControlEvent(EVENT_CORPUS["run.started"])).toBe(true);
    expect(isCoalescibleEvent(EVENT_CORPUS["run.started"])).toBe(false);
  });

  test("a plan update is a control event, not batchable", () => {
    // Reachable from the board.task.plan.update mutation. Batchable, it would
    // be dropped in critical-only mode and the card would lose its plan text.
    expect(isControlEvent(EVENT_CORPUS["board.task_plan_updated"])).toBe(true);
  });

  test("an approval request is never coalescible", () => {
    expect(isControlEvent(EVENT_CORPUS["card.waiting_for_approval"])).toBe(
      true
    );
    expect(isCoalescibleEvent(EVENT_CORPUS["card.waiting_for_approval"])).toBe(
      false
    );
  });

  test("workspace-scoped preference events are control", () => {
    for (const type of [
      "preference.composer_hint_dismissed",
      "preference.speech_voice_set",
      "preference.board_view_mode_set",
      "preference.recent_model_added",
    ] as const) {
      expect(isControlEvent(EVENT_CORPUS[type])).toBe(true);
    }
  });
});

describe("wire envelopes", () => {
  test("a sequenced event carries seq, ts, boardId and the event", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      seq: 1042,
      ts: TS,
      boardId: "board-1",
      event: EVENT_CORPUS["card.waiting_for_approval"],
    });
    expect(message.event.type).toBe("card.waiting_for_approval");
  });

  test("a sequenced event may be workspace scoped", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      seq: 1043,
      ts: TS,
      boardId: null,
      event: EVENT_CORPUS["preference.speech_voice_set"],
    });
    expect(message.boardId).toBeNull();
  });

  test("rejects a negative seq", () => {
    expect(() =>
      sequencedEventSchema.parse({
        type: "event",
        seq: -1,
        ts: TS,
        boardId: "board-1",
        event: EVENT_CORPUS["card.started"],
      })
    ).toThrow();
  });

  test("a snapshot message is versioned at v1", () => {
    const workspace = {
      boards: [board],
      preferences: {
        boardViewMode: "relaxed" as const,
        composerHintDismissed: false,
        recentlyUsedModels: [],
        speechVoiceId: null,
      },
      selectedBoardId: "board-1",
    };
    const versioned = createVersionedSnapshot(workspace);
    expect(versioned.v).toBe(WORKSPACE_SNAPSHOT_VERSION);

    const message = snapshotMessageSchema.parse({
      type: "snapshot",
      seq: 2087,
      data: versioned,
    });
    expect(message.seq).toBe(2087);
  });

  test("a snapshot with a malformed board is rejected", () => {
    // The snapshot is the client's entire resume path; `z.unknown()` here would
    // hand arbitrary shapes straight to the UI.
    expect(() =>
      snapshotMessageSchema.parse({
        type: "snapshot",
        seq: 1,
        data: {
          boards: [{ boardId: "b1" }],
          preferences: {},
          selectedBoardId: "b1",
          v: 1,
        },
      })
    ).toThrow();
  });

  test("a snapshot with malformed preferences is rejected", () => {
    expect(() =>
      snapshotMessageSchema.parse({
        type: "snapshot",
        seq: 1,
        data: {
          boards: [board],
          preferences: { recentlyUsedModels: "nope" },
          selectedBoardId: "b1",
          v: 1,
        },
      })
    ).toThrow();
  });

  test("rejects an envelope whose boardId disagrees with the event", () => {
    // Phase 3 fans out by the envelope value. A mismatch routes the patch to
    // the wrong board's subscribers and is unrecoverable client-side.
    expect(() =>
      sequencedEventSchema.parse({
        type: "event",
        seq: 1042,
        ts: TS,
        boardId: "board-other",
        event: EVENT_CORPUS["card.started"],
      })
    ).toThrow();
  });

  test("rejects an envelope claiming a board for a workspace-scoped event", () => {
    expect(() =>
      sequencedEventSchema.parse({
        type: "event",
        seq: 1043,
        ts: TS,
        boardId: "board-1",
        event: EVENT_CORPUS["preference.speech_voice_set"],
      })
    ).toThrow();
  });

  test("accepts a workspace-scoped envelope with a null boardId", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      seq: 1044,
      ts: TS,
      boardId: null,
      event: EVENT_CORPUS["preference.speech_voice_set"],
    });
    expect(message.boardId).toBeNull();
  });

  test("accepts a deselected board.selected envelope", () => {
    const message = sequencedEventSchema.parse({
      type: "event",
      seq: 1045,
      ts: TS,
      boardId: null,
      event: { type: "board.selected", ts: TS, boardId: null },
    });
    expect(message.boardId).toBeNull();
  });

  test("rejects a snapshot with an unknown version", () => {
    expect(() =>
      snapshotMessageSchema.parse({
        type: "snapshot",
        seq: 1,
        data: {
          boards: [],
          preferences: {},
          selectedBoardId: null,
          v: 99,
        },
      })
    ).toThrow();
  });

  test("server message union parses ready and error shapes", () => {
    expect(serverMessageSchema.parse({ type: "ready", head: 2087 }).head).toBe(
      2087
    );
    expect(
      serverMessageSchema.parse({ type: "error", message: "nope" }).message
    ).toBe("nope");
  });

  test("protocol constants match the spec", () => {
    expect(MAX_REPLAY_GAP).toBe(500);
    expect(WS_CLOSE_UNAUTHORIZED).toBe(4401);
    expect(WS_CLOSE_RATE_LIMITED).toBe(4429);
  });
});
