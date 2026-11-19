import { describe, expect, test } from "bun:test";
import {
  getPendingQuestionApprovals,
  hasPendingQuestion,
  shouldClearAwaitingTaskAction,
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

  test("returns every synchronized question request and ignores permissions", () => {
    const secondQuestion = {
      ...questionApproval,
      requestId: "question-2",
    };
    const requests = getPendingQuestionApprovals({
      pendingApprovals: [questionApproval, permissionApproval, secondQuestion],
    });

    expect(requests).toEqual([questionApproval, secondQuestion]);
  });

  test("supports the legacy single pending question field", () => {
    expect(
      getPendingQuestionApprovals({ pendingApproval: questionApproval })
    ).toEqual([questionApproval]);
  });

  test("keeps permission actions available", () => {
    const task = { pendingApproval: permissionApproval };

    expect(hasPendingQuestion(task)).toBe(false);
    expect(shouldShowReviewActions(task)).toBe(true);
  });

  test("keeps permission actions available after implementation is accepted", () => {
    expect(
      shouldShowReviewActions({
        outcome: "awaiting_review",
        pendingApproval: permissionApproval,
        reviewApproved: true,
      })
    ).toBe(true);
  });

  test("clears the plan action wait when the server accepts the plan", () => {
    expect(
      shouldClearAwaitingTaskAction(
        {
          outcome: "awaiting_review",
          pendingApproval: permissionApproval,
          reviewApproved: true,
        },
        { awaitingEvent: { kind: "review" } }
      )
    ).toBe(true);
  });

  test("keeps a permission action pending until its request is resolved", () => {
    const actionState = {
      awaitingEvent: { kind: "approval" as const, requestId: "permission-1" },
    };

    expect(
      shouldClearAwaitingTaskAction(
        { pendingApproval: permissionApproval },
        actionState
      )
    ).toBe(false);
    expect(shouldClearAwaitingTaskAction({}, actionState)).toBe(true);
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
