import type { PendingApprovalRequest, TaskOutcome } from "@chorus/contracts";

export interface TaskApprovalState {
  outcome?: TaskOutcome;
  pendingApproval?: PendingApprovalRequest;
  pendingApprovals?: PendingApprovalRequest[];
  reviewApproved?: boolean;
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

export function getPendingQuestionApprovals(
  task: TaskApprovalState
): Extract<PendingApprovalRequest, { kind: "question" }>[] {
  return pendingApprovals(task).filter(
    (
      approval
    ): approval is Extract<PendingApprovalRequest, { kind: "question" }> =>
      approval.kind === "question"
  );
}

export function shouldShowReviewActions(task: TaskApprovalState): boolean {
  const approvals = pendingApprovals(task);
  const hasQuestion = approvals.some(
    (approval) => approval.kind === "question"
  );
  const hasPermission = approvals.some(
    (approval) => approval.kind === "permission"
  );

  if (hasQuestion) {
    return hasPermission;
  }
  if (task.outcome === "awaiting_review") {
    return task.reviewApproved !== true;
  }
  return true;
}
