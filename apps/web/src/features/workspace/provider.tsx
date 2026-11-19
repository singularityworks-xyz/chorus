"use client";

import { useRef, useState } from "react";
import {
  createWorkspaceMutation,
  useWorkspaceMutation,
  type WorkspaceMutationFactory,
  type WorkspaceMutationInput,
} from "./actions/use-workspace-mutation";
import { useBoardActions } from "./boards/use-board-actions";
import { useWorkspaceSession } from "./hooks/use-workspace-session";
import { usePreferenceActions } from "./preferences/use-preference-actions";
import { useProjectActions } from "./projects/use-project-actions";
import { usePromptActions } from "./prompts/use-prompt-actions";
import { useSessionActions } from "./session/use-session-actions";
import type { WorkspaceContextValue } from "./types";
import { WorkspaceContext } from "./workspace-context";

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
  const [restoredPrompt, setRestoredPrompt] = useState("");
  const clientIdRef = useRef(crypto.randomUUID());
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
  const boardActions = useBoardActions({
    createMutation,
    dispatch,
    mutateWorkspace,
    state,
  });
  const promptActions = usePromptActions({
    reportUnauthorized,
    selectedBoard: boardActions.selectedBoard,
  });
  const preferenceActions = usePreferenceActions({
    createMutation,
    dispatch,
    mutateWorkspace,
  });
  const sessionActions = useSessionActions(reportUnauthorized);

  const value: WorkspaceContextValue = {
    ...boardActions,
    ...preferenceActions,
    ...projectActions,
    ...promptActions,
    ...sessionActions,
    authExpired,
    boards: state.boards,
    connectionError,
    dismissWorkspaceActionError,
    hydrated,
    lastSeq,
    pendingDrags: state.pendingDrags,
    preferences: state.preferences,
    previousWorkspaces: state.previousWorkspaces,
    restoredPrompt,
    restorePrompt: setRestoredPrompt,
    sessionStatus: status,
    workspaceActionError,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
