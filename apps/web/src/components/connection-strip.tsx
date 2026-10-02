"use client";

import { useWorkspace } from "@/features/workspace/workspace-context";

/**
 * Connection state, made visible.
 *
 * Without this, every failure mode of the socket looks identical: a blank
 * workspace. That includes "still connecting", "reconnecting with backoff", and
 * "the WebSocket URL points at an origin that has no `/ws` route at all" — the
 * last of which is otherwise only discoverable by reading the server log. The
 * human control layer is only meaningful if it can say what is going wrong.
 *
 * Deliberately a thin strip rather than a modal: the workspace stays usable
 * underneath, since cached state is still on screen while a reconnect runs.
 */
export function ConnectionStrip() {
  const { connectionError, hydrated, sessionStatus } = useWorkspace();

  if (sessionStatus === "live" && !connectionError) {
    return null;
  }

  const label = describe(sessionStatus, connectionError, hydrated);

  return (
    <div
      // Announced politely: a reconnect strip appearing mid-task is status, not
      // an emergency, and interrupting a screen reader would be worse than the
      // information is worth.
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
      // Before hydration an empty canvas means "not loaded yet", which is worth
      // saying outright rather than showing as a workspace with nothing in it.
      return hydrated ? "Connecting to Chorus…" : "Loading workspace…";
    case "offline":
      return "Reconnecting to Chorus…";
    case "auth-expired":
      return "Session expired.";
    default:
      return "Connected.";
  }
}
