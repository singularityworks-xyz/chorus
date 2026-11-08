import { describe, expect, test } from "bun:test";
import {
  hasPendingQuestion,
  shouldShowReviewActions,
} from "./task-approval-state";

const questionApproval = {
  kind: "question" as const,
  requestId: "question-1",
  questions: [],
};

const permissionApproval = {
  kind: "permission" as const,
  permission: "write",
  requestId: "permission-1",
};

describe("task approval state", () => {
  test("shows question controls and hides unrelated review actions", () => {
    const task = { pendingApprovals: [questionApproval] };

    expect(hasPendingQuestion(task)).toBe(true);
    expect(shouldShowReviewActions(task)).toBe(false);
  });

  test("keeps permission actions available", () => {
    const task = { pendingApproval: permissionApproval };

    expect(hasPendingQuestion(task)).toBe(false);
    expect(shouldShowReviewActions(task)).toBe(true);
  });

  test("keeps manual plan review actions available", () => {
    expect(shouldShowReviewActions({ outcome: "awaiting_review" })).toBe(true);
  });

  test("does not show plan controls after implementation was accepted", () => {
    expect(
      shouldShowReviewActions({
        outcome: "awaiting_review",
        reviewApproved: true,
      })
    ).toBe(false);
  });
});
