"use client";

import { useWorkspace } from "@/features/workspace/workspace-context";
import { WorkspaceActionError } from "./workspace-action-error";

export function ConnectionStrip() {
  const {
    connectionError,
    dismissWorkspaceActionError,
    hydrated,
    sessionStatus,
    workspaceActionError,
  } = useWorkspace();

  const showConnectionStatus =
    sessionStatus !== "live" || connectionError !== null;

  if (!(workspaceActionError || showConnectionStatus)) {
    return null;
  }

  const label = describe(sessionStatus, connectionError, hydrated);

  return (
    <>
      {workspaceActionError ? (
        <WorkspaceActionError
          message={workspaceActionError}
          onDismiss={dismissWorkspaceActionError}
        />
      ) : null}
      {showConnectionStatus ? (
        <div
          aria-live="polite"
          className="flex items-center justify-center gap-2 border-amber-500/20 border-b bg-amber-500/10 px-3 py-1.5 text-center text-amber-200 text-xs"
          data-testid="connection-strip"
          role="status"
        >
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"
          />
          <span className="truncate">{label}</span>
        </div>
      ) : null}
    </>
  );
}

function describe(
  status: "connecting" | "live" | "offline" | "auth-expired",
  error: string | null,
  hydrated: boolean
): string {
  if (error) {
    return error;
  }

  switch (status) {
    case "connecting":
      return hydrated ? "Connecting to Chorus…" : "Loading workspace…";
    case "offline":
      return "Reconnecting to Chorus…";
    case "auth-expired":
      return "Session expired.";
    default:
      return "Connected.";
  }
}
