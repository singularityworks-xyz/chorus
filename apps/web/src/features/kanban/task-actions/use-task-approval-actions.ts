"use client";

import type { Columns, Task } from "@chorus/contracts";
import posthog from "posthog-js";
import { useCallback } from "react";
import {
  submitTaskApproval,
  submitTaskRejection,
  taskPendingApprovals,
} from "./approval-requests";
import { taskActionErrorMessage } from "./errors";
import type { SetTaskActionState } from "./types";

export function useTaskApprovalActions({
  boardId,
  columns,
  inFlightTaskActionRef,
  sessionId,
  setTaskActionState,
}: {
  boardId: string;
  columns: Columns;
  inFlightTaskActionRef: { current: Set<string> };
  sessionId?: string | undefined;
  setTaskActionState: SetTaskActionState;
}) {
  const handleApprove = useCallback(
    async (taskId: string, plan: string, answers: string[]) => {
      const task = (columns.approve ?? []).find(
        (candidate: Task) => candidate.id === taskId
      );
      if (!task) {
        setTaskActionState(taskId, {
          error:
            "This approval is no longer on the board. Refresh and try again.",
        });
        return;
      }
      if (inFlightTaskActionRef.current.has(taskId)) {
        return;
      }
      if (!sessionId && task.outcome !== "awaiting_review") {
        setTaskActionState(taskId, {
          error: "This board has no active session to approve.",
        });
        return;
      }

      inFlightTaskActionRef.current.add(taskId);
      setTaskActionState(taskId, { pending: "approve" });

      try {
        const permissionRequestId = taskPendingApprovals(task).find(
          (approval) => approval.kind === "permission"
        )?.requestId;
        posthog.capture("kanban_review_approve_start", {
          boardId,
          hasAnswers: answers.some((answer) => answer.length > 0),
          hasPlan: Boolean(plan),
          sessionId,
          taskId,
        });
        await submitTaskApproval({ answers, boardId, plan, sessionId, task });

        setTaskActionState(taskId, {
          awaitingEvent: permissionRequestId
            ? { kind: "approval", requestId: permissionRequestId }
            : { kind: "review" },
          message: "Request accepted. Waiting for the agent to continue…",
        });
        posthog.capture("kanban_review_approve_success", {
          boardId,
          sessionId,
          taskId,
        });
      } catch (error) {
        const message = taskActionErrorMessage(
          error,
          "Could not approve this task. Try again."
        );
        setTaskActionState(taskId, { error: message });
        posthog.capture("kanban_review_approve_error", {
          boardId,
          error: message,
          sessionId,
          taskId,
        });
      } finally {
        inFlightTaskActionRef.current.delete(taskId);
      }
    },
    [boardId, columns, inFlightTaskActionRef, sessionId, setTaskActionState]
  );

  const handleReject = useCallback(
    async (taskId: string) => {
      const task = (columns.approve ?? []).find(
        (candidate: Task) => candidate.id === taskId
      );
      if (!task) {
        setTaskActionState(taskId, {
          error:
            "This approval is no longer on the board. Refresh and try again.",
        });
        return;
      }
      if (inFlightTaskActionRef.current.has(taskId)) {
        return;
      }
      if (!sessionId && task.outcome !== "awaiting_review") {
        setTaskActionState(taskId, {
          error: "This board has no active session to reject.",
        });
        return;
      }

      inFlightTaskActionRef.current.add(taskId);
      setTaskActionState(taskId, { pending: "reject" });
      try {
        const approvals = taskPendingApprovals(task);
        const requestId =
          approvals.find((approval) => approval.kind === "permission")
            ?.requestId ??
          approvals.find((approval) => approval.kind === "question")?.requestId;
        await submitTaskRejection({ boardId, sessionId, task });

        setTaskActionState(taskId, {
          awaitingEvent: requestId
            ? { kind: "approval", requestId }
            : { kind: "review" },
          message: "Request accepted. Waiting for the board to update…",
        });
      } catch (error) {
        const message = taskActionErrorMessage(
          error,
          "Could not reject this task. Try again."
        );
        setTaskActionState(taskId, { error: message });
        posthog.capture("kanban_review_reject_error", {
          boardId,
          error: message,
          sessionId,
          taskId,
        });
      } finally {
        inFlightTaskActionRef.current.delete(taskId);
      }
    },
    [boardId, columns, inFlightTaskActionRef, sessionId, setTaskActionState]
  );

  return { handleApprove, handleReject };
}
