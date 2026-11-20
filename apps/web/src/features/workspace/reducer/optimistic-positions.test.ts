import { describe, expect, test } from "bun:test";
import type { WorkspaceBoard } from "@chorus/contracts";
import {
  DRAG_TIMEOUT_MS,
  displayedPosition,
  expirePendingDrags,
  workspaceReducer,
} from "../reducer";
import { board, movedTo, withBoards } from "./test-support";

describe("optimistic board positions", () => {
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

  test("a non-position event does not settle the drag", () => {
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

    expect(state.pendingDrags.size).toBe(1);
  });

  test("board.moved settles the drag", () => {
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
          position: { x: 800, y: 600 },
          ts: 2,
          type: "board.moved",
        },
      ],
      type: "server/events",
    });

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
