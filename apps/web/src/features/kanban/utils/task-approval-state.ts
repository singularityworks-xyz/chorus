import type { PendingApprovalRequest, TaskOutcome } from "@chorus/contracts";

export interface TaskApprovalState {
  outcome?: TaskOutcome;
  pendingApproval?: PendingApprovalRequest;
  pendingApprovals?: PendingApprovalRequest[];
}

function pendingApprovals(task: TaskApprovalState): PendingApprovalRequest[] {
  return (
    task.pendingApprovals ??
    (task.pendingApproval ? [task.pendingApproval] : [])
  );
}

export function hasPendingQuestion(task: TaskApprovalState): boolean {
  return pendingApprovals(task).some(
    (approval) => approval.kind === "question"
  );
}

export function shouldShowReviewActions(
  task: TaskApprovalState,
  reviewMode: "manual" | "auto"
): boolean {
  const approvals = pendingApprovals(task);
  const hasQuestion = approvals.some(
    (approval) => approval.kind === "question"
  );
  const hasPermission = approvals.some(
    (approval) => approval.kind === "permission"
  );

  return (
    !hasQuestion ||
    hasPermission ||
    (reviewMode === "manual" && task.outcome === "awaiting_review")
  );
}
