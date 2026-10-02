import { describe, expect, test } from "bun:test";
import type { WorkspaceBoard, WorkspaceEvent } from "@chorus/contracts";
import {
  DRAG_TIMEOUT_MS,
  displayedPosition,
  expirePendingDrags,
  INITIAL_WORKSPACE_STATE,
  MAX_PREVIOUS_WORKSPACES,
  type WorkspaceState,
  workspaceReducer,
} from "./reducer";

function board(
  id: string,
  overrides: Partial<WorkspaceBoard> = {}
): WorkspaceBoard {
  return {
    boardId: id,
    columns: { approve: [], done: [], in_progress: [], queue: [] },
    modelSelection: null,
    position: { x: 0, y: 0 },
    repo: {
      directory: `/repos/${id}`,
      projectId: undefined,
      sandboxes: [],
      worktree: `/repos/${id}`,
    },
    reviewMode: "auto",
    session: { state: "uninitialized" },
    title: id,
    ...overrides,
  };
}

function withBoards(boards: WorkspaceBoard[]): WorkspaceState {
  return { ...INITIAL_WORKSPACE_STATE, boards };
}

/** `board.created` carries the whole board under `event.board`. */
function created(target: WorkspaceBoard, ts = 1): WorkspaceEvent {
  return { board: target, boardId: target.boardId, ts, type: "board.created" };
}

function movedTo(x: number, y: number): WorkspaceEvent {
  return {
    boardId: "board-1",
    position: { x, y },
    ts: 1000,
    type: "board.moved",
  };
}

describe("snapshot handling", () => {
  test("a snapshot replaces boards and preferences", () => {
    const state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      boards: [board("board-1"), board("board-2")],
      preferences: {
        boardViewMode: "stacked",
        composerHintDismissed: true,
        recentlyUsedModels: [],
        speechVoiceId: "daniel",
      },
      selectedBoardId: "board-2",
      type: "server/snapshot",
    });

    expect(state.boards).toHaveLength(2);
    expect(state.selectedBoardId).toBe("board-2");
    expect(state.preferences.composerHintDismissed).toBe(true);
    expect(state.preferences.speechVoiceId).toBe("daniel");
  });

  test("a snapshot abandons every pending optimistic drag", () => {
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 900, y: 900 },
      type: "optimistic/drag",
    });

    const state = workspaceReducer(dragged, {
      boards: [board("board-1")],
      preferences: INITIAL_WORKSPACE_STATE.preferences,
      selectedBoardId: null,
      type: "server/snapshot",
    });

    expect(state.pendingDrags.size).toBe(0);
  });

  test("recents survive a snapshot, because the blob does not carry them", () => {
    const seeded: WorkspaceState = {
      ...INITIAL_WORKSPACE_STATE,
      previousWorkspaces: [
        {
          id: "board-9",
          lastOpenedAt: 1,
          repo: board("board-9").repo,
          title: "Old",
        },
      ],
    };

    const state = workspaceReducer(seeded, {
      boards: [],
      preferences: INITIAL_WORKSPACE_STATE.preferences,
      selectedBoardId: null,
      type: "server/snapshot",
    });

    // Clearing here would empty the recents list the first time the server
    // answered, since the versioned snapshot has no such field.
    expect(state.previousWorkspaces).toHaveLength(1);
  });
});

describe("applying events through the shared projector", () => {
  test("board.moved moves the board", () => {
    const state = workspaceReducer(withBoards([board("board-1")]), {
      events: [movedTo(420, 380)],
      type: "server/events",
    });

    expect(state.boards[0]?.position).toEqual({ x: 420, y: 380 });
  });

  test("an event for an unknown board is ignored by the projector", () => {
    const events: WorkspaceEvent[] = [
      movedTo(10, 10),
      {
        boardId: "ghost",
        position: { x: 1, y: 1 },
        ts: 1,
        type: "board.moved",
      },
    ];

    const state = workspaceReducer(withBoards([board("board-1")]), {
      events,
      type: "server/events",
    });

    expect(state.boards).toHaveLength(1);
  });

  test("selection is applied through applyEventToWorkspace", () => {
    const state = workspaceReducer(withBoards([board("board-1")]), {
      events: [{ boardId: "board-1", ts: 1, type: "board.selected" }],
      type: "server/events",
    });

    expect(state.selectedBoardId).toBe("board-1");
  });

  test("preference events are applied, not re-implemented", () => {
    const state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      events: [{ ts: 1, type: "preference.composer_hint_dismissed" }],
      type: "server/events",
    });

    expect(state.preferences.composerHintDismissed).toBe(true);
  });

  test("an approval event reaches the board it belongs to", () => {
    const withCard = board("board-1", {
      columns: {
        approve: [],
        done: [],
        in_progress: [
          {
            id: "task-1",
            label: "repo",
            labelVariant: "primary-light",
            title: "Do it",
          },
        ],
        queue: [],
      },
    });

    const state = workspaceReducer(withBoards([withCard]), {
      events: [
        {
          boardId: "board-1",
          kind: "permission",
          taskId: "task-1",
          ts: 1,
          type: "card.waiting_for_approval",
        },
      ],
      type: "server/events",
    });

    expect(state.boards[0]?.columns.approve).toHaveLength(1);
    expect(state.boards[0]?.columns.in_progress).toHaveLength(0);
  });

  test("a sequence of events applies in order", () => {
    const state = workspaceReducer(withBoards([board("board-1")]), {
      events: [movedTo(10, 10), movedTo(20, 20), movedTo(30, 30)],
      type: "server/events",
    });

    expect(state.boards[0]?.position).toEqual({ x: 30, y: 30 });
  });

  test("an empty event list is harmless", () => {
    const before = withBoards([board("board-1")]);
    const after = workspaceReducer(before, {
      events: [],
      type: "server/events",
    });

    expect(after.boards).toBe(before.boards);
  });
});

describe("optimistic drag (plan P5 task 4)", () => {
  test("a drag is shown immediately, before the server confirms", () => {
    const state = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    const now = Date.now();
    expect(
      displayedPosition(
        state.boards[0] as WorkspaceBoard,
        state.pendingDrags,
        now
      )
    ).toEqual({
      x: 800,
      y: 600,
    });
    // The authoritative state is untouched until the event lands.
    expect(state.boards[0]?.position).toEqual({ x: 0, y: 0 });
  });

  test("a confirming event settles the drag and the server position wins", () => {
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    const state = workspaceReducer(dragged, {
      events: [movedTo(810, 610)],
      type: "server/events",
    });

    expect(state.pendingDrags.size).toBe(0);
    expect(state.boards[0]?.position).toEqual({ x: 810, y: 610 });
  });

  test("a server patch that contradicts the guess wins anyway", () => {
    // Two devices, or one device that guessed wrong. The plan is explicit: if
    // the server patch contradicts the pending drag, the server wins.
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    const state = workspaceReducer(dragged, {
      events: [movedTo(5, 5)],
      type: "server/events",
    });

    const now = Date.now();
    expect(
      displayedPosition(
        state.boards[0] as WorkspaceBoard,
        state.pendingDrags,
        now
      )
    ).toEqual({
      x: 5,
      y: 5,
    });
  });

  test("an unrelated event for the same board also settles the drag", () => {
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    const state = workspaceReducer(dragged, {
      events: [
        {
          boardId: "board-1",
          reviewMode: "manual",
          ts: 1,
          type: "board.review_mode_set",
        },
      ],
      type: "server/events",
    });

    // Board-scoped correlation rather than by mutation id: the event vocabulary
    // has no mutationId field, so any event for the board resolves its guess.
    expect(state.pendingDrags.size).toBe(0);
  });

  test("an event for a different board leaves the drag alone", () => {
    const dragged = workspaceReducer(
      withBoards([board("board-1"), board("board-2")]),
      {
        boardId: "board-1",
        mutationId: "m1",
        position: { x: 800, y: 600 },
        type: "optimistic/drag",
      }
    );

    const state = workspaceReducer(dragged, {
      events: [
        {
          boardId: "board-2",
          position: { x: 1, y: 1 },
          ts: 1,
          type: "board.moved",
        },
      ],
      type: "server/events",
    });

    expect(state.pendingDrags.size).toBe(1);
    expect(state.pendingDrags.has("board-1")).toBe(true);
  });

  test("a workspace-scoped event leaves drags alone", () => {
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    const state = workspaceReducer(dragged, {
      events: [{ boardId: null, ts: 1, type: "board.selected" }],
      type: "server/events",
    });

    expect(state.pendingDrags.size).toBe(1);
  });

  test("the deadline is five seconds", () => {
    expect(DRAG_TIMEOUT_MS).toBe(5000);
  });

  test("an expired guess is abandoned and the server position shows", () => {
    const now = Date.now();
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    // Nothing ever confirmed it, which is what happens when the mutation fails.
    const expired = expirePendingDrags(dragged, now + DRAG_TIMEOUT_MS + 1);

    expect(expired.pendingDrags.size).toBe(0);
    expect(
      displayedPosition(
        expired.boards[0] as WorkspaceBoard,
        expired.pendingDrags,
        now
      )
    ).toEqual({ x: 0, y: 0 });
  });

  test("expire is a no-op before the deadline", () => {
    const now = Date.now();
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    expect(expirePendingDrags(dragged, now)).toBe(dragged);
  });

  test("a stale guess stops being displayed once its deadline passes", () => {
    const now = Date.now();
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    // Even before the sweeper runs, the renderer stops trusting it.
    expect(
      displayedPosition(
        dragged.boards[0] as WorkspaceBoard,
        dragged.pendingDrags,
        now + DRAG_TIMEOUT_MS + 1
      )
    ).toEqual({ x: 0, y: 0 });
  });

  test("drag-settle clears an entry without an event", () => {
    const dragged = workspaceReducer(withBoards([board("board-1")]), {
      boardId: "board-1",
      mutationId: "m1",
      position: { x: 800, y: 600 },
      type: "optimistic/drag",
    });

    expect(
      workspaceReducer(dragged, {
        boardId: "board-1",
        type: "optimistic/drag-settle",
      }).pendingDrags.size
    ).toBe(0);
  });

  test("drag-settle on a board with no guess returns the same state", () => {
    const state = withBoards([board("board-1")]);

    expect(
      workspaceReducer(state, {
        boardId: "board-1",
        type: "optimistic/drag-settle",
      })
    ).toBe(state);
  });

  test("drags on different boards are tracked independently", () => {
    let state = withBoards([board("board-1"), board("board-2")]);
    for (const [boardId, x] of [
      ["board-1", 100],
      ["board-2", 200],
    ] as const) {
      state = workspaceReducer(state, {
        boardId,
        mutationId: `m-${boardId}`,
        position: { x, y: 0 },
        type: "optimistic/drag",
      });
    }

    expect(state.pendingDrags.size).toBe(2);

    const settled = workspaceReducer(state, {
      events: [movedTo(999, 999)],
      type: "server/events",
    });

    expect(settled.pendingDrags.size).toBe(1);
    expect(settled.pendingDrags.has("board-2")).toBe(true);
  });
});

describe("recent boards", () => {
  test("creating a board records it", () => {
    const state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      events: [
        created(
          board("board-1", {
            repo: {
              directory: "/repos/a",
              projectId: undefined,
              sandboxes: [],
              worktree: "/repos/a",
            },
          })
        ),
      ],
      type: "server/events",
    });

    expect(state.previousWorkspaces).toHaveLength(1);
    expect(state.previousWorkspaces[0]?.title).toBe("board-1");
  });

  test("reopening a repo replaces its entry rather than stacking", () => {
    let state = INITIAL_WORKSPACE_STATE;

    for (const id of ["board-1", "board-1"]) {
      state = workspaceReducer(state, {
        events: [
          created(
            board(id, {
              repo: {
                directory: "/repos/a",
                projectId: undefined,
                sandboxes: [],
                worktree: "/repos/a",
              },
            })
          ),
        ],
        type: "server/events",
      });
    }

    // Recents is keyed on the repo directory, so a second board over the same
    // repository replaces its entry instead of stacking a duplicate the operator
    // would see twice in the picker.
    expect(state.previousWorkspaces).toHaveLength(1);
  });

  test("removing a board drops its recents entry", () => {
    let state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      events: [
        created(
          board("board-1", {
            repo: {
              directory: "/repos/a",
              projectId: undefined,
              sandboxes: [],
              worktree: "/repos/a",
            },
          })
        ),
      ],
      type: "server/events",
    });

    state = workspaceReducer(state, {
      events: [{ boardId: "board-1", ts: 2, type: "board.removed" }],
      type: "server/events",
    });

    expect(state.previousWorkspaces).toHaveLength(0);
    expect(state.boards).toHaveLength(0);
  });

  test("the recents list is bounded", () => {
    let state = INITIAL_WORKSPACE_STATE;

    for (let index = 0; index < MAX_PREVIOUS_WORKSPACES + 4; index += 1) {
      const boardId = `board-${String(index)}`;
      state = workspaceReducer(state, {
        events: [created(board(boardId), index)],
        type: "server/events",
      });
    }

    expect(state.previousWorkspaces.length).toBeLessThanOrEqual(
      MAX_PREVIOUS_WORKSPACES
    );
  });
});

describe("local optimistic preferences", () => {
  test("view mode applies locally without waiting for the server", () => {
    const state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      mode: "stacked",
      type: "local/view-mode",
    });

    expect(state.preferences.boardViewMode).toBe("stacked");
  });

  test("a server preference event overrides a local guess", () => {
    const local = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      mode: "stacked",
      type: "local/view-mode",
    });

    const state = workspaceReducer(local, {
      events: [
        { mode: "relaxed", ts: 1, type: "preference.board_view_mode_set" },
      ],
      type: "server/events",
    });

    expect(state.preferences.boardViewMode).toBe("relaxed");
  });

  test("voice and hint actions work locally", () => {
    const withVoice = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      type: "local/voice",
      voiceId: "daniel",
    });
    expect(withVoice.preferences.speechVoiceId).toBe("daniel");

    const dismissed = workspaceReducer(withVoice, {
      composerHintDismissed: true,
      type: "local/hint-dismissed",
    });
    expect(dismissed.preferences.composerHintDismissed).toBe(true);
  });
});

/**
 * The shared projector is deliberately NOT idempotent, and this pins that so
 * nobody "hardens" it by accident.
 *
 * `card.created` appends and `step.delta_appended` concatenates, so applying the
 * same event twice produces visible duplicated state. That is what makes the
 * transport's `eventsAfterSnapshot` filter load-bearing: a snapshot already
 * contains every buffered event, so replaying the buffer would double them.
 * The filter itself is covered in `protocol.test.ts`.
 */
describe("the projector is not idempotent", () => {
  test("card.created appends rather than deduping", () => {
    const snapshotBoard = board("board-1", {
      columns: {
        approve: [],
        done: [],
        in_progress: [],
        queue: [
          {
            id: "card-1",
            label: "Write spec",
            labelVariant: "primary-light",
            title: "Write spec",
          },
        ],
      },
    });

    const afterSnapshot = workspaceReducer(withBoards([snapshotBoard]), {
      boards: [snapshotBoard],
      preferences: INITIAL_WORKSPACE_STATE.preferences,
      selectedBoardId: "board-1",
      type: "server/snapshot",
    });

    const afterReplay = workspaceReducer(afterSnapshot, {
      events: [
        {
          boardId: "board-1",
          column: "queue",
          task: {
            id: "card-1",
            label: "Write spec",
            labelVariant: "primary-light",
            title: "Write spec",
          },
          taskId: "card-1",
          ts: 1,
          type: "card.created",
        },
      ],
      type: "server/events",
    });

    expect(
      afterReplay.boards[0]?.columns.queue.filter((t) => t.id === "card-1")
    ).toHaveLength(2);
  });

  test("step.delta_appended concatenates rather than replacing", () => {
    const snapshotBoard = board("board-1", {
      columns: {
        approve: [],
        done: [],
        in_progress: [],
        queue: [
          {
            id: "card-1",
            label: "Write spec",
            labelVariant: "primary-light",
            run: {
              elapsed: "0s",
              model: "test-model",
              startedAt: 1,
              steps: [
                {
                  content: "hello",
                  id: "step-1",
                  kind: "response",
                  status: "running",
                  summary: "hello",
                },
              ],
              taskTitle: "Write spec",
            },
            title: "Write spec",
          },
        ],
      },
    });

    const afterSnapshot = workspaceReducer(withBoards([snapshotBoard]), {
      boards: [snapshotBoard],
      preferences: INITIAL_WORKSPACE_STATE.preferences,
      selectedBoardId: "board-1",
      type: "server/snapshot",
    });

    const afterReplay = workspaceReducer(afterSnapshot, {
      events: [
        {
          boardId: "board-1",
          delta: "hello",
          stepId: "step-1",
          taskId: "card-1",
          ts: 2,
          type: "step.delta_appended",
        },
      ],
      type: "server/events",
    });

    const step = afterReplay.boards[0]?.columns.queue[0]?.run?.steps[0];
    expect(step?.content).toBe("hellohello");
  });
});
