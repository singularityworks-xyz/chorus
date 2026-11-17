import { describe, expect, test } from "bun:test";
import {
  INITIAL_RECENT_PROJECTS_STATE,
  recentProjectsReducer,
} from "./recent-projects-state";
import type { WorkspaceProject } from "./types";

const project: WorkspaceProject = {
  directory: "/repo",
  projectName: "Example",
  sandboxes: [],
  worktree: "/repo",
};

describe("recent projects state", () => {
  test("an initial failure is an error, not an empty successful list", () => {
    const loading = recentProjectsReducer(INITIAL_RECENT_PROJECTS_STATE, {
      type: "request-started",
    });
    const failed = recentProjectsReducer(loading, {
      message: "Could not reach Chorus. Check the connection and retry.",
      type: "request-failed",
    });

    expect(loading.isLoading).toBe(true);
    expect(failed.isLoading).toBe(false);
    expect(failed.hasLoaded).toBe(false);
    expect(failed.projects).toEqual([]);
    expect(failed.error).toContain("Could not reach Chorus");
  });

  test("a refresh failure preserves the last successful project list", () => {
    const loaded = recentProjectsReducer(INITIAL_RECENT_PROJECTS_STATE, {
      projects: [project],
      type: "request-succeeded",
    });
    const refreshing = recentProjectsReducer(loaded, {
      type: "request-started",
    });
    const failed = recentProjectsReducer(refreshing, {
      message: "Repository access is temporarily unavailable.",
      type: "request-failed",
    });

    expect(refreshing.projects).toEqual([project]);
    expect(failed.projects).toEqual([project]);
    expect(failed.hasLoaded).toBe(true);
    expect(failed.isLoading).toBe(false);
    expect(failed.error).toBe("Repository access is temporarily unavailable.");
  });

  test("success records an empty list and clears a previous error", () => {
    const failed = recentProjectsReducer(INITIAL_RECENT_PROJECTS_STATE, {
      message: "Temporary failure.",
      type: "request-failed",
    });
    const recovered = recentProjectsReducer(failed, {
      projects: [],
      type: "request-succeeded",
    });

    expect(recovered.hasLoaded).toBe(true);
    expect(recovered.projects).toEqual([]);
    expect(recovered.error).toBeNull();
  });

  test("unauthorized responses clear project errors without claiming success", () => {
    const failed = recentProjectsReducer(INITIAL_RECENT_PROJECTS_STATE, {
      message: "Temporary failure.",
      type: "request-failed",
    });
    const unauthorized = recentProjectsReducer(failed, {
      type: "request-unauthorized",
    });

    expect(unauthorized.error).toBeNull();
    expect(unauthorized.hasLoaded).toBe(false);
    expect(unauthorized.projects).toEqual([]);
  });
});
