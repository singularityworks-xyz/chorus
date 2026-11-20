import type { ModelSelection, WorkspaceMutation } from "@chorus/contracts";
import { useCallback, useState } from "react";
import type { WorkspaceMutationFactory } from "../actions/use-workspace-mutation";
import type { WorkspaceAction } from "../reducer";
import type { WorkspaceContextValue } from "../types";

export function usePreferenceActions({
  createMutation,
  dispatch,
  mutateWorkspace,
}: {
  createMutation: WorkspaceMutationFactory;
  dispatch: React.Dispatch<WorkspaceAction>;
  mutateWorkspace: (mutation: WorkspaceMutation) => Promise<void>;
}) {
  const [boardLayoutVersion, setBoardLayoutVersion] = useState(0);

  const dismissComposerHint = useCallback(() => {
    dispatch({ composerHintDismissed: true, type: "local/hint-dismissed" });
    mutateWorkspace(
      createMutation({ type: "preference.dismiss_composer_hint", payload: {} })
    ).catch((error: unknown) => {
      console.error("Failed to dismiss composer hint:", error);
    });
  }, [createMutation, dispatch, mutateWorkspace]);

  const setSpeechVoiceId = useCallback(
    (voiceId: string | null) => {
      dispatch({ type: "local/voice", voiceId });
      mutateWorkspace(
        createMutation({
          type: "preference.speech_voice.set",
          payload: { voiceId },
        })
      ).catch((error: unknown) => {
        console.error("Failed to update speech voice:", error);
      });
    },
    [createMutation, dispatch, mutateWorkspace]
  );

  const setBoardViewMode = useCallback(
    (mode: WorkspaceContextValue["preferences"]["boardViewMode"]) => {
      dispatch({ mode, type: "local/view-mode" });
      setBoardLayoutVersion((current) => current + 1);
      mutateWorkspace(
        createMutation({
          type: "preference.board_view_mode.set",
          payload: { mode },
        })
      ).catch((error: unknown) => {
        console.error("Failed to update board view mode:", error);
      });
    },
    [createMutation, dispatch, mutateWorkspace]
  );

  const setDefaultModelSelection = useCallback(
    async (model: ModelSelection | null): Promise<void> => {
      await mutateWorkspace(
        createMutation({
          type: "preference.default_model.set",
          payload: { model },
        })
      );
    },
    [createMutation, mutateWorkspace]
  );

  const addRecentModel = useCallback(
    (model: Parameters<WorkspaceContextValue["addRecentModel"]>[0]) => {
      mutateWorkspace(
        createMutation({
          type: "preference.recently_used_models.add",
          payload: { model },
        })
      ).catch((error: unknown) => {
        console.error("Failed to add recent model:", error);
      });
    },
    [createMutation, mutateWorkspace]
  );

  return {
    addRecentModel,
    boardLayoutVersion,
    dismissComposerHint,
    setBoardViewMode,
    setDefaultModelSelection,
    setSpeechVoiceId,
  };
}
