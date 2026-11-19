import { boardSeedSchema, type WorkspaceMutation } from "@chorus/contracts";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ChorusApiError } from "@/lib/chorus-api-error";
import type { WorkspaceMutationFactory } from "../actions/use-workspace-mutation";
import type { WorkspaceContextValue } from "../types";
import {
  OPEN_FOLDER_ERROR,
  workspaceActionErrorMessage,
  workspaceApiError,
} from "../workspace-action-error";
import { PROJECT_LIST_ERROR, requestRecentProjects } from "./projects-client";
import {
  INITIAL_RECENT_PROJECTS_STATE,
  recentProjectsReducer,
} from "./recent-projects-state";

export function useProjectActions({
  createMutation,
  mutateWorkspace,
  reportUnauthorized,
  setWorkspaceActionError,
  sessionStatus,
}: {
  createMutation: WorkspaceMutationFactory;
  mutateWorkspace: (mutation: WorkspaceMutation) => Promise<void>;
  reportUnauthorized: (response: Response) => boolean;
  setWorkspaceActionError: React.Dispatch<React.SetStateAction<string | null>>;
  sessionStatus: WorkspaceContextValue["sessionStatus"];
}) {
  const [recentProjectsState, dispatchRecentProjects] = useReducer(
    recentProjectsReducer,
    INITIAL_RECENT_PROJECTS_STATE
  );
  const projectsLoadControllerRef = useRef<AbortController | null>(null);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);

  const loadProjects = useCallback(async () => {
    projectsLoadControllerRef.current?.abort();
    const controller = new AbortController();
    projectsLoadControllerRef.current = controller;
    dispatchRecentProjects({ type: "request-started" });

    try {
      const projects = await requestRecentProjects({
        onUnauthorized: reportUnauthorized,
        signal: controller.signal,
      });

      if (controller.signal.aborted) {
        return;
      }

      if (projects === null) {
        dispatchRecentProjects({ type: "request-unauthorized" });
        return;
      }

      dispatchRecentProjects({ projects, type: "request-succeeded" });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      dispatchRecentProjects({
        message: error instanceof Error ? error.message : PROJECT_LIST_ERROR,
        type: "request-failed",
      });
    } finally {
      if (projectsLoadControllerRef.current === controller) {
        projectsLoadControllerRef.current = null;
      }
    }
  }, [reportUnauthorized]);

  useEffect(() => {
    // Wait until the socket confirms the session before calling protected routes.
    if (sessionStatus !== "live" || recentProjectsState.hasLoaded) {
      return;
    }

    loadProjects().catch((error: unknown) => {
      dispatchRecentProjects({
        message: error instanceof Error ? error.message : PROJECT_LIST_ERROR,
        type: "request-failed",
      });
    });
    return () => {
      const controller = projectsLoadControllerRef.current;
      projectsLoadControllerRef.current = null;
      controller?.abort();
    };
  }, [loadProjects, recentProjectsState.hasLoaded, sessionStatus]);

  const openFolder = useCallback(async () => {
    setIsOpeningFolder(true);
    setWorkspaceActionError(null);

    try {
      const response = await fetch("/api/projects/open-folder", {
        method: "POST",
      });

      if (reportUnauthorized(response)) {
        return;
      }

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        setWorkspaceActionError(
          workspaceApiError(payload, OPEN_FOLDER_ERROR).message
        );
        return;
      }

      const responseText = await response.text();
      const payload =
        responseText.trim().length === 0 ? null : JSON.parse(responseText);

      if (payload === null) {
        return;
      }

      await mutateWorkspace(
        createMutation({
          type: "board.create",
          payload: { seed: boardSeedSchema.parse(payload) },
        })
      );
      await loadProjects();
    } catch (error) {
      console.error("Failed to open folder:", error);
      if (!(error instanceof ChorusApiError && error.code === "unauthorized")) {
        setWorkspaceActionError(
          workspaceActionErrorMessage(error, OPEN_FOLDER_ERROR)
        );
      }
    } finally {
      setIsOpeningFolder(false);
    }
  }, [
    createMutation,
    loadProjects,
    mutateWorkspace,
    reportUnauthorized,
    setWorkspaceActionError,
  ]);

  const createBoardFromProject = useCallback(
    (project: WorkspaceContextValue["recentProjects"][number]) => {
      mutateWorkspace(
        createMutation({
          type: "board.create",
          payload: {
            seed: {
              repo: { ...project },
              title:
                project.projectName ??
                project.directory.split("/").filter(Boolean).at(-1) ??
                project.directory,
            },
          },
        })
      ).catch((error: unknown) => {
        console.error("Failed to create board from project:", error);
      });
    },
    [createMutation, mutateWorkspace]
  );

  const createBoardFromHistory = useCallback(
    (entry: WorkspaceContextValue["previousWorkspaces"][number]) => {
      mutateWorkspace(
        createMutation({
          type: "board.create",
          payload: { seed: { repo: entry.repo, title: entry.title } },
        })
      ).catch((error: unknown) => {
        console.error("Failed to create board from history:", error);
      });
    },
    [createMutation, mutateWorkspace]
  );

  return {
    createBoardFromHistory,
    createBoardFromProject,
    isLoadingRecentProjects: recentProjectsState.isLoading,
    isOpeningFolder,
    loadProjects,
    openFolder,
    recentProjects: recentProjectsState.projects,
    recentProjectsError: recentProjectsState.error,
    recentProjectsLoaded: recentProjectsState.hasLoaded,
  };
}
