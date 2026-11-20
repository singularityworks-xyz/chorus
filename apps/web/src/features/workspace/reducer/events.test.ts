import { describe, expect, test } from "bun:test";
import type { WorkspaceEvent } from "@chorus/contracts";
import { INITIAL_WORKSPACE_STATE, workspaceReducer } from "../reducer";
import { board, movedTo, withBoards } from "./test-support";

describe("applying events through the shared projector", () => {
  test("board.moved moves the board", () => {
    const state = workspaceReducer(withBoards([board("board-1")]), {
      events: [movedTo(420, 380)],
      type: "server/events",
    });

    expect(state.boards[0]?.position).toEqual({ x: 420, y: 380 });
  });

  test("removing the selected board selects the first remaining board", () => {
    const state = workspaceReducer(
      {
        ...withBoards([board("board-1"), board("board-2")]),
        selectedBoardId: "board-2",
      },
      {
        events: [{ boardId: "board-2", ts: 1000, type: "board.removed" }],
        type: "server/events",
      }
    );

    expect(state.boards.map((candidate) => candidate.boardId)).toEqual([
      "board-1",
    ]);
    expect(state.selectedBoardId).toBe("board-1");
  });

  test("removing a different board preserves the current selection", () => {
    const state = workspaceReducer(
      {
        ...withBoards([board("board-1"), board("board-2")]),
        selectedBoardId: "board-2",
      },
      {
        events: [{ boardId: "board-1", ts: 1000, type: "board.removed" }],
        type: "server/events",
      }
    );

    expect(state.selectedBoardId).toBe("board-2");
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
