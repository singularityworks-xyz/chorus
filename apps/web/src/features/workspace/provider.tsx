"use client";

import {
  boardSeedSchema,
  projectListResponseSchema,
  queueBoardPromptResponseSchema,
  type SequencedEvent,
  type VersionedSnapshot,
  type WorkspaceEvent,
  type WorkspaceMutation,
} from "@chorus/contracts";
import posthog from "posthog-js";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useKanbanHistory } from "@/features/kanban/hooks/use-kanban-history";
import { useChorusSync } from "@/features/sync/use-chorus-sync";
import {
  DRAG_TIMEOUT_MS,
  INITIAL_WORKSPACE_STATE,
  workspaceReducer,
} from "./reducer";
import type { WorkspaceContextValue } from "./types";
import { WorkspaceContext } from "./workspace-context";

/**
 * Workspace provider (plan P5 task 4).
 *
 * The important change from the previous version is that there is no longer a
 * second state channel. State arrives as sequenced patches over one socket, is
 * folded in by the shared `applyEventToBoard` inside the reducer, and the only
 * thing this file does optimistically is board dragging.
 *
 * The old provider held boards in component state and reassigned the whole array
 * from an HTTP snapshot and again from a full-state frame — the dual-channel
 * drift the spec calls out as the thing to delete. There is no longer any
 * wholesale-replacement setter in this file; state only moves through the
 * reducer.
 */

function getModelLabel(model?: {
  modelID: string;
  providerID: string;
}): string {
  return model ? `${model.providerID}/${model.modelID}` : "OpenCode default";
}

function createWorkspaceMutation<T extends WorkspaceMutation["type"]>(
  clientId: string,
  baseRevision: number,
  type: T,
  payload: Extract<WorkspaceMutation, { type: T }>["payload"]
): WorkspaceMutation {
  return {
    baseRevision,
    clientId,
    mutationId: crypto.randomUUID(),
    type,
    payload,
  } as Extract<WorkspaceMutation, { type: T }>;
}

export function ChorusWorkspaceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(
    workspaceReducer,
    INITIAL_WORKSPACE_STATE
  );
  const {
    boards,
    pendingDrags,
    preferences,
    previousWorkspaces,
    selectedBoardId,
  } = state;

  const [boardLayoutVersion, setBoardLayoutVersion] = useState(0);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const [isQueueingPrompt, setIsQueueingPrompt] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<
    WorkspaceContextValue["recentProjects"]
  >([]);
  const [restoredPrompt, setRestoredPrompt] = useState("");

  const clientIdRef = useRef(crypto.randomUUID());
  const revisionRef = useRef(0);

  const kanbanHistory = useKanbanHistory();

  const selectedBoard = boards.find(
    (board) => board.boardId === selectedBoardId
  );

  // ── sync ──────────────────────────────────────────────────────────────────

  const applySnapshot = useCallback(
    (snapshot: VersionedSnapshot, buffered: WorkspaceEvent[]) => {
      revisionRef.current = 0;
      dispatch({
        boards: snapshot.boards,
        preferences: snapshot.preferences,
        selectedBoardId: snapshot.selectedBoardId,
        type: "server/snapshot",
      });

      // `buffered` is already filtered to sequences the snapshot does not
      // contain, so this cannot duplicate anything the snapshot just supplied.
      if (buffered.length > 0) {
        dispatch({ events: buffered, type: "server/events" });
      }
      setConnectionError(null);
    },
    []
  );

  const applyEvent = useCallback((frame: SequencedEvent) => {
    dispatch({ events: [frame.event], type: "server/events" });
  }, []);

  const {
    error: syncError,
    hydrated,
    lastSeq,
    status,
  } = useChorusSync({
    onAuthExpired: () => {
      // Stop here rather than reconnecting: a dead cookie does not resolve
      // without a human, and retrying is an infinite loop.
      setAuthExpired(true);
    },
    onEvent: applyEvent,
    onRestoredSnapshot: (snapshot) => {
      // Repaint immediately from what the last session persisted, so a reload
      // shows the workspace before the socket has said anything.
      dispatch({
        boards: snapshot.boards,
        preferences: snapshot.preferences,
        selectedBoardId: snapshot.selectedBoardId,
        type: "server/snapshot",
      });
    },
    onSnapshot: applySnapshot,
  });

  useEffect(() => {
    setConnectionError(syncError);
  }, [syncError]);

  /**
   * Abandons optimistic guesses that never got a confirming event.
   *
   * Without this a dropped mutation would pin a board in the wrong place for the
   * rest of the session.
   */
  // The timer is created once and left running, rather than being re-created
  // whenever `pendingDrags.size` changes. Re-creating it restarted the countdown
  // each time a drag was added, so a drag arriving just after a tick had to wait
  // a whole interval for its first sweep -- and the interval was torn down
  // exactly when the last drag settled. A no-op dispatch is cheap; `expirePendingDrags`
  // only touches entries whose deadline has passed.
  const hasPendingDrags = pendingDrags.size > 0;
  const pendingDragsRef = useRef(hasPendingDrags);
  pendingDragsRef.current = hasPendingDrags;

  useEffect(() => {
    const timer = setInterval(
      () => {
        if (pendingDragsRef.current) {
          dispatch({ now: Date.now(), type: "optimistic/expire-drags" });
        }
      },
      Math.max(1000, Math.floor(DRAG_TIMEOUT_MS / 2))
    );

    return () => {
      clearInterval(timer);
    };
  }, []);

  // ── commands (HTTP) ───────────────────────────────────────────────────────

  const reportUnauthorized = useCallback((response: Response) => {
    if (response.status === 401) {
      setAuthExpired(true);
      return true;
    }
    return false;
  }, []);

  /**
   * Sends one mutation.
   *
   * No snapshot is read back: the socket delivers the resulting event, and
   * reading a snapshot here would reintroduce the second state channel.
   */
  const mutateWorkspace = useCallback(
    async (mutation: WorkspaceMutation): Promise<void> => {
      const response = await fetch("/api/workspace", {
        body: JSON.stringify(mutation),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (reportUnauthorized(response)) {
        throw new Error("unauthorized");
      }

      if (!response.ok) {
        throw new Error(`mutation failed: ${String(response.status)}`);
      }
    },
    [reportUnauthorized]
  );

  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });

      if (!response.ok) {
        return;
      }

      setRecentProjects(
        projectListResponseSchema.parse(await response.json()).projects
      );
    } catch (error) {
      console.error("Failed to load projects:", error);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // ── handlers ──────────────────────────────────────────────────────────────

  const openFolder = useCallback(async () => {
    setIsOpeningFolder(true);

    try {
      const response = await fetch("/api/projects/open-folder", {
        method: "POST",
      });

      if (reportUnauthorized(response) || !response.ok) {
        return;
      }

      const responseText = await response.text();
      const payload =
        responseText.trim().length === 0 ? null : JSON.parse(responseText);

      if (payload === null) {
        return;
      }

      await mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.create",
          {
            seed: boardSeedSchema.parse(payload),
          }
        )
      );

      await loadProjects();
    } catch (error) {
      console.error("Failed to open folder:", error);
    } finally {
      setIsOpeningFolder(false);
    }
  }, [loadProjects, mutateWorkspace, reportUnauthorized]);

  const createBoardFromRecentProject = useCallback(
    (project: WorkspaceContextValue["recentProjects"][number]) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.create",
          {
            seed: {
              repo: { ...project },
              title:
                project.projectName ??
                project.directory.split("/").filter(Boolean).at(-1) ??
                project.directory,
            },
          }
        )
      ).catch((error: unknown) => {
        console.error("Failed to create board from project:", error);
      });
    },
    [mutateWorkspace]
  );

  const createBoardFromHistory = useCallback(
    (entry: WorkspaceContextValue["previousWorkspaces"][number]) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.create",
          {
            seed: { repo: entry.repo, title: entry.title },
          }
        )
      ).catch((error: unknown) => {
        console.error("Failed to create board from history:", error);
      });
    },
    [mutateWorkspace]
  );

  const removeBoard = useCallback(
    (boardId: string) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.remove",
          {
            boardId,
          }
        )
      ).catch((error: unknown) => {
        console.error("Failed to remove board:", error);
      });
    },
    [mutateWorkspace]
  );

  const selectBoard = useCallback(
    (boardId: string) => {
      dispatch({ boardId, type: "optimistic/drag-settle" });
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.select",
          {
            boardId,
          }
        )
      ).catch((error: unknown) => {
        console.error("Failed to select board:", error);
      });
    },
    [mutateWorkspace]
  );

  const clearSelection = useCallback(() => {
    mutateWorkspace(
      createWorkspaceMutation(
        clientIdRef.current,
        revisionRef.current,
        "board.select",
        {
          boardId: null,
        }
      )
    ).catch((error: unknown) => {
      console.error("Failed to clear selection:", error);
    });
  }, [mutateWorkspace]);

  /**
   * Queues a prompt.
   *
   * No optimistic card is inserted. Spec §9 permits optimism only for cosmetic
   * mutations such as a drag, and a locally-fabricated task would need its own
   * projector — the exact drift the shared reducer exists to prevent. The card
   * appears when the server's `card.queued` event arrives.
   */
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
          throw new Error(`Failed to queue prompt: ${String(response.status)}`);
        }

        const payload = queueBoardPromptResponseSchema.parse(
          await response.json()
        );

        // The authoritative card arrives as a `card.queued` event over the
        // socket. This placeholder exists only so the composer can clear itself
        // and show the board it queued against.
        return {
          ...payload,
          task: {
            id: `pending-${payload.timestamp}`,
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
      } catch (error) {
        console.error("Failed to queue prompt:", error);
        return null;
      } finally {
        setIsQueueingPrompt(false);
      }
    },
    [reportUnauthorized, selectedBoard]
  );

  const dismissComposerHint = useCallback(() => {
    dispatch({ composerHintDismissed: true, type: "local/hint-dismissed" });
    mutateWorkspace(
      createWorkspaceMutation(
        clientIdRef.current,
        revisionRef.current,
        "preference.dismiss_composer_hint",
        {}
      )
    ).catch((error: unknown) => {
      console.error("Failed to dismiss composer hint:", error);
    });
  }, [mutateWorkspace]);

  const setSpeechVoiceId = useCallback(
    (voiceId: string | null) => {
      dispatch({ type: "local/voice", voiceId });
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "preference.speech_voice.set",
          { voiceId }
        )
      ).catch((error: unknown) => {
        console.error("Failed to update speech voice:", error);
      });
    },
    [mutateWorkspace]
  );

  const setBoardViewMode = useCallback(
    (mode: WorkspaceContextValue["preferences"]["boardViewMode"]) => {
      dispatch({ mode, type: "local/view-mode" });
      setBoardLayoutVersion((current) => current + 1);
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "preference.board_view_mode.set",
          { mode }
        )
      ).catch((error: unknown) => {
        console.error("Failed to update board view mode:", error);
      });
    },
    [mutateWorkspace]
  );

  /**
   * Board position.
   *
   * The only optimistic mutation in the app: applied locally so the card does not
   * snap back to its old spot while the mutation is in flight, and abandoned by
   * the sweeper or by any confirming event if it never lands.
   */
  const updateBoardPosition = useCallback(
    (boardId: string, position: { x: number; y: number }) => {
      const mutation = createWorkspaceMutation(
        clientIdRef.current,
        revisionRef.current,
        "board.move",
        { boardId, position }
      );

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
    [mutateWorkspace]
  );

  const updateBoardColumns = useCallback(
    (
      boardId: string,
      columns: Parameters<WorkspaceContextValue["updateBoardColumns"]>[1]
    ) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.columns.replace",
          { boardId, columns }
        )
      ).catch((error: unknown) => {
        console.error("Failed to update board columns:", error);
      });
    },
    [mutateWorkspace]
  );

  const updateBoardReviewMode = useCallback(
    (
      boardId: string,
      reviewMode: Parameters<WorkspaceContextValue["updateBoardReviewMode"]>[1]
    ) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.review_mode.set",
          { boardId, reviewMode }
        )
      ).catch((error: unknown) => {
        console.error("Failed to update board review mode:", error);
      });
    },
    [mutateWorkspace]
  );

  const setBoardModel = useCallback(
    (
      boardId: string,
      model: Parameters<WorkspaceContextValue["setBoardModel"]>[1]
    ) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.model.set",
          {
            boardId,
            model,
          }
        )
      ).catch((error: unknown) => {
        console.error("Failed to set board model:", error);
      });
    },
    [mutateWorkspace]
  );

  const addRecentModel = useCallback(
    (model: Parameters<WorkspaceContextValue["addRecentModel"]>[0]) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "preference.recently_used_models.add",
          { model }
        )
      ).catch((error: unknown) => {
        console.error("Failed to add recent model:", error);
      });
    },
    [mutateWorkspace]
  );

  const sessionCommand = useCallback(
    async (command: "undo" | "redo"): Promise<boolean> => {
      if (!selectedBoard?.session.sessionId) {
        return false;
      }

      const endpoint =
        command === "undo"
          ? `/api/sessions/${selectedBoard.session.sessionId}/revert`
          : `/api/sessions/${selectedBoard.session.sessionId}/unrevert`;

      try {
        const response = await fetch(endpoint, { method: "POST" });

        if (reportUnauthorized(response)) {
          return false;
        }

        posthog.capture(
          response.ok ? "session_command_success" : "session_command_error",
          {
            command,
            sessionID: selectedBoard.session.sessionId,
            status: response.status,
            timestamp: Date.now(),
          }
        );

        return response.ok;
      } catch (error) {
        posthog.capture("session_command_exception", {
          command,
          errorMessage: error instanceof Error ? error.message : String(error),
          sessionID: selectedBoard.session.sessionId,
          timestamp: Date.now(),
        });
        return false;
      }
    },
    [reportUnauthorized, selectedBoard]
  );

  const recordMove = useCallback(
    (
      columnsBefore: Parameters<
        WorkspaceContextValue["kanbanHistory"]["recordMove"]
      >[0],
      columnsAfter: Parameters<
        WorkspaceContextValue["kanbanHistory"]["recordMove"]
      >[1],
      task: Parameters<WorkspaceContextValue["kanbanHistory"]["recordMove"]>[2]
    ) => {
      kanbanHistory.recordMove(columnsBefore, columnsAfter, task);
    },
    [kanbanHistory]
  );

  const value: WorkspaceContextValue = {
    addRecentModel,
    authExpired,
    boardLayoutVersion,
    boards,
    clearSelection,
    connectionError,
    hydrated,
    createBoardFromHistory,
    createBoardFromProject: createBoardFromRecentProject,
    dismissComposerHint,
    isOpeningFolder,
    isQueueingPrompt,
    kanbanHistory: {
      canRedo: kanbanHistory.canRedo,
      canUndo: kanbanHistory.canUndo,
      redo: kanbanHistory.redo,
      recordMove,
      undo: kanbanHistory.undo,
    },
    lastSeq,
    loadProjects,
    openFolder,
    pendingDrags,
    preferences,
    previousWorkspaces,
    queuePrompt,
    recentProjects,
    removeBoard,
    restoredPrompt,
    restorePrompt: setRestoredPrompt,
    selectBoard,
    selectedBoard,
    selectedBoardId,
    sessionCommand,
    sessionStatus: status,
    setBoardModel,
    setBoardViewMode,
    setSpeechVoiceId,
    updateBoardColumns,
    updateBoardPosition,
    updateBoardReviewMode,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
