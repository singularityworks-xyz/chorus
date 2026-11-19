import { describe, expect, test } from "bun:test";
import { INITIAL_WORKSPACE_STATE, workspaceReducer } from "../reducer";

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
