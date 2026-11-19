import type { WorkspaceProject } from "../types";

export interface RecentProjectsState {
  error: string | null;
  hasLoaded: boolean;
  isLoading: boolean;
  projects: WorkspaceProject[];
}

export type RecentProjectsAction =
  | { type: "request-started" }
  | { projects: WorkspaceProject[]; type: "request-succeeded" }
  | { message: string; type: "request-failed" }
  | { type: "request-unauthorized" };

export const INITIAL_RECENT_PROJECTS_STATE: RecentProjectsState = {
  error: null,
  hasLoaded: false,
  isLoading: false,
  projects: [],
};

export function recentProjectsReducer(
  state: RecentProjectsState,
  action: RecentProjectsAction
): RecentProjectsState {
  switch (action.type) {
    case "request-started":
      return { ...state, isLoading: true };
    case "request-succeeded":
      return {
        error: null,
        hasLoaded: true,
        isLoading: false,
        projects: action.projects,
      };
    case "request-failed":
      return { ...state, error: action.message, isLoading: false };
    case "request-unauthorized":
      return { ...state, error: null, isLoading: false };
    default:
      return state;
  }
}
