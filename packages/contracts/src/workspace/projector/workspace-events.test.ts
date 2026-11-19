import { describe, expect, test } from "bun:test";
import { applyEventToWorkspace } from "../projector";
import { BOARD, makeBoard, T0, TASK } from "./test-support";

describe("workspace-scoped events", () => {
  const workspace = {
    boards: [makeBoard()],
    preferences: {
      boardViewMode: "relaxed" as const,
      composerHintDismissed: false,
      defaultModelSelection: null,
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

  test("global model selection is shared and can be cleared", () => {
    const selected = applyEventToWorkspace(workspace, {
      type: "preference.default_model_set",
      ts: T0,
      model: { providerID: "anthropic", modelID: "claude" },
    });
    expect(selected.preferences.defaultModelSelection).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });

    const cleared = applyEventToWorkspace(selected, {
      type: "preference.default_model_set",
      ts: T0,
      model: null,
    });
    expect(cleared.preferences.defaultModelSelection).toBeNull();
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
