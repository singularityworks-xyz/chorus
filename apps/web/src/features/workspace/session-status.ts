export type WorkspaceSessionStatus =
  | "connecting"
  | "live"
  | "offline"
  | "auth-expired";

export function isWorkspaceSessionLive(status: WorkspaceSessionStatus) {
  return status === "live";
}
