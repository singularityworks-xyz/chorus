"use client";

import {
  boardSeedSchema,
  projectListResponseSchema,
  queueBoardPromptResponseSchema,
  type WorkspaceMutation,
  type WorkspaceSnapshot,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import posthog from "posthog-js";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useKanbanHistory } from "@/features/kanban/hooks/use-kanban-history";
import {
  attachPromptTask,
  attachSessionToBoard,
  createPromptTask,
  updateBoardColumns as nextBoardColumns,
  updateBoardPosition as nextBoardPosition,
  updateBoardReviewMode as nextBoardReviewMode,
} from "./state";
import type {
  AgentEventEnvelope,
  WorkspaceBoard,
  WorkspaceContextValue,
} from "./types";
import { WorkspaceContext } from "./workspace-context";

function getChorusWsUrl() {
  return process.env.NEXT_PUBLIC_CHORUS_WS_URL ?? "ws://localhost:2000/ws";
}

function getModelLabel(model?: { modelID: string; providerID: string }) {
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
  const [boards, setBoards] = useState<WorkspaceContextValue["boards"]>([]);
  const [boardLayoutVersion, setBoardLayoutVersion] = useState(0);
  const [preferences, setPreferences] = useState<
    WorkspaceContextValue["preferences"]
  >({
    boardViewMode: "relaxed",
    composerHintDismissed: false,
    recentlyUsedModels: [],
    speechVoiceId: null,
  });
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<
    WorkspaceContextValue["recentProjects"]
  >([]);
  const [previousWorkspaces, setPreviousWorkspaces] = useState<
    WorkspaceContextValue["previousWorkspaces"]
  >([]);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const [isQueueingPrompt, setIsQueueingPrompt] = useState(false);
  const [restoredPrompt, setRestoredPrompt] = useState("");
  const clientIdRef = useRef(crypto.randomUUID());
  const revisionRef = useRef(0);

  const kanbanHistory = useKanbanHistory();

  const restorePrompt = useEffectEvent((text: string) => {
    setRestoredPrompt(text);
  });

  const selectedBoard = boards.find(
    (board) => board.boardId === selectedBoardId
  );

  const applySnapshot = useEffectEvent((snapshot: WorkspaceSnapshot) => {
    if (snapshot.revision < revisionRef.current) {
      return;
    }

    revisionRef.current = snapshot.revision;
    setBoards(snapshot.boards);
    setPreferences(snapshot.preferences);
    setSelectedBoardId(snapshot.selectedBoardId);
    setPreviousWorkspaces(snapshot.previousWorkspaces);
  });

  const mutateWorkspace = useEffectEvent(
    async (mutation: WorkspaceMutation) => {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(mutation),
      });

      if (!response.ok) {
        let errorMessage = `Failed to mutate workspace (${response.status} ${response.statusText})`;
        try {
          const errorData = await response.json();
          if (errorData.code) {
            errorMessage = `${errorMessage}: ${errorData.code}`;
          }
          if (errorData.issues) {
            errorMessage = `${errorMessage} - ${JSON.stringify(errorData.issues)}`;
          }
        } catch {
          // Response body might not be JSON, try text
          try {
            const errorText = await response.text();
            if (errorText) {
              errorMessage = `${errorMessage}: ${errorText}`;
            }
          } catch {
            // Ignore if we can't read the body
          }
        }
        console.error("Workspace mutation failed:", {
          status: response.status,
          statusText: response.statusText,
          mutation: {
            type: mutation.type,
            mutationId: mutation.mutationId,
            baseRevision: mutation.baseRevision,
          },
        });
        throw new Error(errorMessage);
      }

      const snapshot = workspaceSnapshotSchema.parse(await response.json());
      applySnapshot(snapshot);
      return snapshot;
    }
  );

  const removeBoardById = useEffectEvent((boardId: string) => {
    setBoards((currentBoards) => {
      const remainingBoards = currentBoards.filter(
        (board) => board.boardId !== boardId
      );

      setSelectedBoardId((currentSelectedBoardId) => {
        if (currentSelectedBoardId !== boardId) {
          return currentSelectedBoardId;
        }

        return remainingBoards[0]?.boardId ?? null;
      });

      return remainingBoards;
    });

    mutateWorkspace(
      createWorkspaceMutation(
        clientIdRef.current,
        revisionRef.current,
        "board.remove",
        {
          boardId,
        }
      )
    ).catch((error) => {
      console.error("Failed to remove board", error);
    });
  });

  const loadProjects = useEffectEvent(async () => {
    const response = await fetch("/api/projects", {
      cache: "no-store",
    });

    if (!response.ok) {
      return;
    }

    const payload = projectListResponseSchema.parse(await response.json());
    setRecentProjects(payload.projects);
  });

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    let isCancelled = false;

    async function hydrateWorkspace() {
      try {
        const [projectsResponse, workspaceResponse] = await Promise.all([
          fetch("/api/projects", {
            cache: "no-store",
          }),
          fetch("/api/workspace", {
            cache: "no-store",
          }),
        ]);

        if (isCancelled) {
          return;
        }

        if (projectsResponse.ok) {
          const projectsPayload = projectListResponseSchema.parse(
            await projectsResponse.json()
          );
          setRecentProjects(projectsPayload.projects);
        }

        if (workspaceResponse.ok) {
          const snapshot = workspaceSnapshotSchema.parse(
            await workspaceResponse.json()
          );

          applySnapshot(snapshot);
        }
      } catch (error) {
        console.error("Failed to hydrate workspace", error);
      }
    }

    hydrateWorkspace().catch((error) => {
      console.error("Failed to hydrate workspace", error);
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    const socket = new WebSocket(getChorusWsUrl());

    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data) as AgentEventEnvelope;
        if (parsed.type === "workspace.updated") {
          const snapshot = workspaceSnapshotSchema.parse(parsed.payload);
          console.log("[chorus:ws] workspace.updated", {
            revision: snapshot.revision,
            boardCount: snapshot.boards.length,
            boards: snapshot.boards.map((b) => ({
              id: b.boardId,
              title: b.title,
              sessionId: b.session.sessionId,
              currentTaskId: b.session.currentTaskId,
              taskCounts: Object.fromEntries(
                Object.entries(b.columns).map(([col, tasks]) => [
                  col,
                  tasks.length,
                ])
              ),
              steps: Object.values(b.columns)
                .flat()
                .filter((t) => t.run)
                .flatMap((t) => t.run?.steps ?? [])
                .map((s) => ({
                  kind: s.kind,
                  summary: s.summary,
                  status: s.status,
                })),
            })),
          });
          applySnapshot(snapshot);
          return;
        }
      } catch (error) {
        console.error("Failed to parse Chorus event", error);
      }
    };

    return () => {
      socket.close();
    };
  }, []);

  const openFolder = useEffectEvent(async () => {
    setIsOpeningFolder(true);

    try {
      const response = await fetch("/api/projects/open-folder", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to open folder");
      }

      const responseText = await response.text();
      const payload =
        responseText.trim().length === 0 ? null : JSON.parse(responseText);
      if (payload === null) {
        return;
      }

      const seed = boardSeedSchema.parse(payload);
      await mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.create",
          {
            seed,
          }
        )
      );

      loadProjects();
    } finally {
      setIsOpeningFolder(false);
    }
  });

  const createBoardFromRecentProject = useEffectEvent(
    (project: WorkspaceContextValue["recentProjects"][number]) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.create",
          {
            seed: {
              title:
                project.projectName ??
                project.directory.split("/").filter(Boolean).at(-1) ??
                project.directory,
              repo: {
                ...project,
              },
            },
          }
        )
      ).catch((error) => {
        console.error("Failed to create board from project", error);
      });
    }
  );

  const createBoardFromHistory = useEffectEvent(
    (entry: WorkspaceContextValue["previousWorkspaces"][number]) => {
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.create",
          {
            seed: {
              title: entry.title,
              repo: entry.repo,
            },
          }
        )
      ).catch((error) => {
        console.error("Failed to create board from history", error);
      });
    }
  );

  const queuePrompt = useEffectEvent(
    async (input: {
      agent?: string;
      model?: {
        modelID: string;
        providerID: string;
      };
      parts?: Array<{
        type: string;
        text?: string;
        filename?: string;
        path?: string;
        mime?: string;
        isDirectory?: boolean;
        lineRange?: { start: number; end: number };
      }>;
      text: string;
    }) => {
      if (!selectedBoard) {
        return null;
      }

      const task = createPromptTask({
        board: selectedBoard,
        modelLabel: getModelLabel(input.model),
        prompt: input.text,
      });
      const preparedSessionState =
        selectedBoard.session.sessionId === undefined ? "starting" : "active";
      const preparedBoard: WorkspaceBoard = {
        ...attachPromptTask(selectedBoard, task),
        session: {
          ...attachPromptTask(selectedBoard, task).session,
          state: preparedSessionState,
        },
      };

      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.boardId === selectedBoard.boardId ? preparedBoard : board
        )
      );

      setIsQueueingPrompt(true);

      try {
        await mutateWorkspace(
          createWorkspaceMutation(
            clientIdRef.current,
            revisionRef.current,
            "board.columns.replace",
            {
              boardId: selectedBoard.boardId,
              columns: preparedBoard.columns,
            }
          )
        );
        await mutateWorkspace(
          createWorkspaceMutation(
            clientIdRef.current,
            revisionRef.current,
            "board.session.patch",
            {
              boardId: selectedBoard.boardId,
              session: {
                currentTaskId: preparedBoard.session.currentTaskId,
                errorMessage: undefined,
                sessionId: selectedBoard.session.sessionId,
                state: preparedSessionState,
              },
            }
          )
        );

        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            boardId: selectedBoard.boardId,
            directory: selectedBoard.repo.directory,
            projectId: selectedBoard.repo.projectId,
            sessionId: selectedBoard.session.sessionId,
            text: input.text,
            agent: input.agent,
            model: input.model,
            parts: input.parts,
            reviewMode: selectedBoard.reviewMode ?? "auto",
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to queue prompt");
        }

        const payload = queueBoardPromptResponseSchema.parse(
          await response.json()
        );

        setBoards((currentBoards) =>
          currentBoards.map((board) =>
            board.boardId === payload.boardId
              ? attachSessionToBoard(board, payload.sessionId)
              : board
          )
        );

        return {
          ...payload,
          task,
        };
      } catch (error) {
        setBoards((currentBoards) =>
          currentBoards.map((board) =>
            board.boardId === selectedBoard.boardId
              ? {
                  ...board,
                  session: {
                    ...board.session,
                    state: "error",
                    errorMessage:
                      error instanceof Error ? error.message : "Queue failed",
                    currentTaskId: undefined,
                  },
                }
              : board
          )
        );

        return null;
      } finally {
        setIsQueueingPrompt(false);
      }
    }
  );

  const value: WorkspaceContextValue = {
    boards,
    boardLayoutVersion,
    selectedBoardId,
    selectedBoard,
    recentProjects,
    previousWorkspaces,
    preferences,
    isOpeningFolder,
    isQueueingPrompt,
    loadProjects,
    openFolder,
    createBoardFromProject: createBoardFromRecentProject,
    createBoardFromHistory,
    dismissComposerHint: () =>
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "preference.dismiss_composer_hint",
          {}
        )
      ).catch((error) => {
        console.error("Failed to dismiss composer hint", error);
      }),
    setSpeechVoiceId: (voiceId) => {
      setPreferences((currentPreferences) => ({
        ...currentPreferences,
        speechVoiceId: voiceId,
      }));
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "preference.speech_voice.set",
          {
            voiceId,
          }
        )
      ).catch((error) => {
        console.error("Failed to update speech voice", error);
      });
    },
    setBoardViewMode: (mode) => {
      setPreferences((currentPreferences) => ({
        ...currentPreferences,
        boardViewMode: mode,
      }));
      setBoardLayoutVersion((currentVersion) => currentVersion + 1);
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "preference.board_view_mode.set",
          {
            mode,
          }
        )
      ).catch((error) => {
        console.error("Failed to update board view mode", error);
      });
    },
    removeBoard: removeBoardById,
    selectBoard: (boardId) => {
      setSelectedBoardId(boardId);
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.select",
          {
            boardId,
          }
        )
      ).catch((error) => {
        console.error("Failed to select board", error);
      });
    },
    clearSelection: () => {
      setSelectedBoardId(null);
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.select",
          {
            boardId: null,
          }
        )
      ).catch((error) => {
        console.error("Failed to clear selection", error);
      });
    },
    sessionCommand: async (command: "undo" | "redo") => {
      if (!selectedBoard?.session.sessionId) {
        posthog.capture("session_command_no_session", {
          command,
          timestamp: Date.now(),
        });
        return false;
      }

      const sessionState = selectedBoard.session.state;
      const hasActiveTask = selectedBoard.session.currentTaskId != null;

      posthog.capture("session_command_start", {
        command,
        sessionID: selectedBoard.session.sessionId,
        sessionState,
        hasActiveTask,
        timestamp: Date.now(),
      });

      try {
        const endpoint =
          command === "undo"
            ? `/api/sessions/${selectedBoard.session.sessionId}/revert`
            : `/api/sessions/${selectedBoard.session.sessionId}/unrevert`;

        const response = await fetch(endpoint, { method: "POST" });

        let responseBody: Record<string, unknown> | null = null;
        try {
          responseBody = await response.json();
        } catch {
          // Response may not be JSON
        }

        if (response.ok) {
          posthog.capture("session_command_success", {
            command,
            sessionID: selectedBoard.session.sessionId,
            responseBody,
            timestamp: Date.now(),
          });
        } else {
          posthog.capture("session_command_error", {
            command,
            sessionID: selectedBoard.session.sessionId,
            status: response.status,
            statusText: response.statusText,
            responseBody,
            timestamp: Date.now(),
          });
        }

        return response.ok;
      } catch (error) {
        posthog.capture("session_command_exception", {
          command,
          sessionID: selectedBoard.session.sessionId,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorType: error instanceof Error ? error.name : typeof error,
          errorStack: error instanceof Error ? error.stack : undefined,
          timestamp: Date.now(),
        });
        return false;
      }
    },
    updateBoardColumns: (boardId, columns) => {
      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.boardId === boardId ? nextBoardColumns(board, columns) : board
        )
      );
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.columns.replace",
          {
            boardId,
            columns,
          }
        )
      ).catch((error) => {
        console.error("Failed to update board columns", error);
      });
    },
    updateBoardPosition: (boardId, position) => {
      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.boardId === boardId ? nextBoardPosition(board, position) : board
        )
      );
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.move",
          {
            boardId,
            position,
          }
        )
      ).catch((error) => {
        console.error("Failed to update board position", error);
      });
    },
    updateBoardReviewMode: (boardId, reviewMode) => {
      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.boardId === boardId
            ? nextBoardReviewMode(board, reviewMode)
            : board
        )
      );
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "board.review_mode.set",
          {
            boardId,
            reviewMode,
          }
        )
      ).catch((error) => {
        console.error("Failed to update board review mode", error);
      });
    },
    setBoardModel: (boardId, model) => {
      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.boardId === boardId
            ? { ...board, modelSelection: model }
            : board
        )
      );
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
      ).catch((error) => {
        console.error("Failed to set board model", error);
      });
    },
    addRecentModel: (model) => {
      setPreferences((currentPreferences) => {
        const existing = currentPreferences.recentlyUsedModels;
        const filtered = existing.filter(
          (m) =>
            !(m.providerID === model.providerID && m.modelID === model.modelID)
        );
        const updated = [model, ...filtered].slice(0, 5);
        return { ...currentPreferences, recentlyUsedModels: updated };
      });
      mutateWorkspace(
        createWorkspaceMutation(
          clientIdRef.current,
          revisionRef.current,
          "preference.recently_used_models.add",
          { model }
        )
      ).catch((error) => {
        console.error("Failed to add recent model", error);
      });
    },
    kanbanHistory: {
      canRedo: kanbanHistory.canRedo,
      canUndo: kanbanHistory.canUndo,
      redo: kanbanHistory.redo,
      recordMove: kanbanHistory.recordMove,
      undo: kanbanHistory.undo,
    },
    restoredPrompt,
    restorePrompt,
    queuePrompt,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
