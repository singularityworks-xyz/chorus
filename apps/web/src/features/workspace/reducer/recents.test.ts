import { describe, expect, test } from "bun:test";
import {
  INITIAL_WORKSPACE_STATE,
  MAX_PREVIOUS_WORKSPACES,
  workspaceReducer,
} from "../reducer";
import { board, created } from "./test-support";

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
