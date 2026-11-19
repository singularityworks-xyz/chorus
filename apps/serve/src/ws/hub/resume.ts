import { MAX_REPLAY_GAP } from "@chorus/contracts";

export type ResumeDecision =
  | { kind: "replay"; fromSeq: number }
  | {
      kind: "snapshot";
      reason:
        | "client-ahead"
        | "gap-too-large"
        | "initial"
        | "pruned"
        | "workspace-changed";
    }
  | { kind: "up-to-date" };

export function decideResume(
  since: number,
  head: number,
  replayFloor: number,
  workspaceMatches = true
): ResumeDecision {
  if (!workspaceMatches) {
    return { kind: "snapshot", reason: "workspace-changed" };
  }
  if (since > head) {
    return { kind: "snapshot", reason: "client-ahead" };
  }
  if (since === head) {
    return { kind: "up-to-date" };
  }
  if (since < replayFloor) {
    return { kind: "snapshot", reason: "pruned" };
  }
  if (head - since > MAX_REPLAY_GAP) {
    return { kind: "snapshot", reason: "gap-too-large" };
  }
  return { kind: "replay", fromSeq: since };
}
