"use client";

import {
  apiErrorSchema,
  type BoardSessionHistoryCommand,
  type ModelSelection,
  queueBoardPromptResponseSchema,
} from "@chorus/contracts";
import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { sendBoardSessionHistoryCommand } from "@/features/kanban/board-session-history-client";
import { ChorusApiError } from "@/lib/chorus-api-error";
import {
  createWorkspaceMutation,
  useWorkspaceMutation,
  type WorkspaceMutationFactory,
  type WorkspaceMutationInput,
} from "./actions/use-workspace-mutation";
import { useWorkspaceSession } from "./hooks/use-workspace-session";
import { useProjectActions } from "./projects/use-project-actions";
import { isCurrentBoardSelection } from "./state";
import type { WorkspaceContextValue } from "./types";
import { WorkspaceContext } from "./workspace-context";

function getModelLabel(model?: {
  modelID: string;
  providerID: string;
}): string {
  return model ? `${model.providerID}/${model.modelID}` : "OpenCode default";
}

export function ChorusWorkspaceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const {
    authExpired,
    connectionError,
    dispatch,
    hydrated,
    lastSeq,
    reportUnauthorized,
    revisionRef,
    state,
    status,
  } = useWorkspaceSession();
  const {
    boards,
    pendingDrags,
    preferences,
    previousWorkspaces,
    selectedBoardId: persistedSelectedBoardId,
  } = state;

  const [localBoardFocus, setLocalBoardFocus] = useState<string | null>(null);
  const selectedBoardId = localBoardFocus ?? persistedSelectedBoardId;
  const [boardLayoutVersion, setBoardLayoutVersion] = useState(0);
  const [isQueueingPrompt, setIsQueueingPrompt] = useState(false);
  const [restoredPrompt, setRestoredPrompt] = useState("");
  const [sessionHistoryChange, setSessionHistoryChange] = useState<{
    boardId: string;
    revision: number;
  } | null>(null);

  const clientIdRef = useRef(crypto.randomUUID());
  const sessionHistoryRevisionRef = useRef(0);
  const createMutation = useRef<WorkspaceMutationFactory>(
    (input: WorkspaceMutationInput) =>
      createWorkspaceMutation(clientIdRef.current, revisionRef.current, input)
  ).current;
  const {
    dismissWorkspaceActionError,
    mutateWorkspace,
    setWorkspaceActionError,
    workspaceActionError,
  } = useWorkspaceMutation(reportUnauthorized);
  const projectActions = useProjectActions({
    createMutation,
    mutateWorkspace,
    reportUnauthorized,
    setWorkspaceActionError,
    sessionStatus: status,
  });
  const selectedBoard = boards.find(
    (board) => board.boardId === selectedBoardId
  );

  useEffect(() => {
    if (
      localBoardFocus &&
      !boards.some((board) => board.boardId === localBoardFocus)
    ) {
      setLocalBoardFocus(null);
    }
  }, [boards, localBoardFocus]);

  const removeBoard = useCallback(
    (boardId: string) => {
      return mutateWorkspace(
        createMutation({ type: "board.remove", payload: { boardId } })
      );
    },
    [createMutation, mutateWorkspace]
  );

  const selectBoard = useCallback(
    (boardId: string) => {
      setLocalBoardFocus(null);
      dispatch({ boardId, type: "optimistic/drag-settle" });
      if (isCurrentBoardSelection(persistedSelectedBoardId, boardId)) {
        return;
      }
      mutateWorkspace(
        createMutation({ type: "board.select", payload: { boardId } })
      ).catch((error: unknown) => {
        console.error("Failed to select board:", error);
      });
    },
    [createMutation, dispatch, mutateWorkspace, persistedSelectedBoardId]
  );

  const focusBoardLocally = useCallback((boardId: string) => {
    setLocalBoardFocus(boardId);
  }, []);

  const clearSelection = useCallback(() => {
    mutateWorkspace(
      createMutation({ type: "board.select", payload: { boardId: null } })
    ).catch((error: unknown) => {
      console.error("Failed to clear selection:", error);
    });
  }, [createMutation, mutateWorkspace]);

  const queuePrompt = useCallback(
    async (
      input: Parameters<WorkspaceContextValue["queuePrompt"]>[0]
    ): ReturnType<WorkspaceContextValue["queuePrompt"]> => {
      if (!selectedBoard) {
        return null;
      }

      setIsQueueingPrompt(true);

      try {
        const response = await fetch("/api/tasks", {
          body: JSON.stringify({
            agent: input.agent,
            boardId: selectedBoard.boardId,
            directory: selectedBoard.repo.directory,
            model: input.model,
            parts: input.parts,
            projectId: selectedBoard.repo.projectId,
            reviewMode: selectedBoard.reviewMode ?? "auto",
            sessionId: selectedBoard.session.sessionId,
            text: input.text,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        if (reportUnauthorized(response)) {
          throw new Error("unauthorized");
        }

        if (!response.ok) {
          const errorPayload = apiErrorSchema.safeParse(
            await response.json().catch(() => undefined)
          );
          if (errorPayload.success) {
            throw new ChorusApiError(
              errorPayload.data.code,
              errorPayload.data.message
            );
          }
          throw new Error("prompt_request_failed");
        }

        const payload = queueBoardPromptResponseSchema.parse(
          await response.json()
        );

        // The queued event creates the card; this response only clears the composer.
        return {
          ...payload,
          task: {
            id: payload.taskId,
            label:
              selectedBoard.repo.projectName ??
              selectedBoard.repo.directory.split("/").filter(Boolean).at(-1) ??
              selectedBoard.repo.directory,
            labelVariant: "primary-light",
            run: {
              elapsed: "0m 00s",
              model: getModelLabel(input.model),
              startedAt: payload.timestamp,
              steps: [],
              taskTitle: input.text.slice(0, 96),
            },
            title: input.text.slice(0, 96),
          },
        };
      } finally {
        setIsQueueingPrompt(false);
      }
    },
    [reportUnauthorized, selectedBoard]
  );

  const dismissComposerHint = useCallback(() => {
    dispatch({ composerHintDismissed: true, type: "local/hint-dismissed" });
    mutateWorkspace(
      createMutation({
        type: "preference.dismiss_composer_hint",
        payload: {},
      })
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

  const updateBoardPosition = useCallback(
    (boardId: string, position: { x: number; y: number }) => {
      const mutation = createMutation({
        type: "board.move",
        payload: { boardId, position },
      });

      dispatch({
        boardId,
        mutationId: mutation.mutationId,
        position,
        type: "optimistic/drag",
      });

      mutateWorkspace(mutation).catch((error: unknown) => {
        // Drop the guess immediately rather than waiting out the deadline.
        dispatch({ boardId, type: "optimistic/drag-settle" });
        console.error("Failed to update board position:", error);
      });
    },
    [createMutation, dispatch, mutateWorkspace]
  );

  const reorderBoardTask = useCallback(
    (
      boardId: string,
      taskId: string,
      column: Parameters<WorkspaceContextValue["reorderBoardTask"]>[2],
      beforeTaskId: string | null
    ) =>
      mutateWorkspace(
        createMutation({
          type: "board.task.reorder",
          payload: { beforeTaskId, boardId, column, taskId },
        })
      ),
    [createMutation, mutateWorkspace]
  );

  const updateBoardReviewMode = useCallback(
    (
      boardId: string,
      reviewMode: Parameters<WorkspaceContextValue["updateBoardReviewMode"]>[1]
    ) => {
      return mutateWorkspace(
        createMutation({
          type: "board.review_mode.set",
          payload: { boardId, reviewMode },
        })
      );
    },
    [createMutation, mutateWorkspace]
  );

  const setBoardModel = useCallback(
    (
      boardId: string,
      model: Parameters<WorkspaceContextValue["setBoardModel"]>[1]
    ) => {
      mutateWorkspace(
        createMutation({ type: "board.model.set", payload: { boardId, model } })
      ).catch((error: unknown) => {
        console.error("Failed to set board model:", error);
      });
    },
    [createMutation, mutateWorkspace]
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

  const sessionCommand = useCallback(
    async (boardId: string, command: BoardSessionHistoryCommand) => {
      try {
        const result = await sendBoardSessionHistoryCommand(boardId, command, {
          onUnauthorized: reportUnauthorized,
        });

        posthog.capture("session_command_success", {
          boardId,
          command,
          sessionID: result.sessionId,
          timestamp: Date.now(),
        });
        sessionHistoryRevisionRef.current += 1;
        setSessionHistoryChange({
          boardId,
          revision: sessionHistoryRevisionRef.current,
        });

        return { ok: true };
      } catch (error) {
        posthog.capture("session_command_exception", {
          boardId,
          command,
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
        return {
          error:
            error instanceof Error
              ? error.message
              : `Could not ${command} repository changes. Check the board connection and try again.`,
          ok: false,
        };
      }
    },
    [reportUnauthorized]
  );

  const value: WorkspaceContextValue = {
    ...projectActions,
    addRecentModel,
    authExpired,
    boardLayoutVersion,
    boards,
    clearSelection,
    connectionError,
    dismissWorkspaceActionError,
    hydrated,
    dismissComposerHint,
    focusBoardLocally,
    isQueueingPrompt,
    lastSeq,
    pendingDrags,
    preferences,
    previousWorkspaces,
    queuePrompt,
    removeBoard,
    restoredPrompt,
    restorePrompt: setRestoredPrompt,
    selectBoard,
    sessionHistoryChange,
    selectedBoard,
    selectedBoardId,
    sessionCommand,
    sessionStatus: status,
    setBoardModel,
    setDefaultModelSelection,
    setBoardViewMode,
    setSpeechVoiceId,
    reorderBoardTask,
    updateBoardPosition,
    updateBoardReviewMode,
    workspaceActionError,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
