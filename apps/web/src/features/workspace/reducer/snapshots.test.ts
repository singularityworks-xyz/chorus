import { describe, expect, test } from "bun:test";
import {
  INITIAL_WORKSPACE_STATE,
  type WorkspaceState,
  workspaceReducer,
} from "../reducer";
import { board, withBoards } from "./test-support";

describe("snapshot handling", () => {
  test("a snapshot replaces boards and preferences", () => {
    const state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      boards: [board("board-1"), board("board-2")],
      preferences: {
        boardViewMode: "stacked",
        composerHintDismissed: true,
        defaultModelSelection: null,
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

    expect(state.previousWorkspaces).toHaveLength(1);
  });
});
