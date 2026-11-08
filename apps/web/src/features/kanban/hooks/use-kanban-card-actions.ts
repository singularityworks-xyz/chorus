"use client";

import {
  acceptedCommandResponseSchema,
  apiErrorSchema,
  boardTaskCommandResponseSchema,
  type Columns,
  type Task,
} from "@chorus/contracts";
import posthog from "posthog-js";
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-context";

export interface KanbanTaskActionState {
  awaitingEvent?: boolean;
  error?: string;
  message?: string;
  pending?: "approve" | "reject" | "run" | "retry";
}

export interface KanbanCardActions {
  actionStates: Record<string, KanbanTaskActionState | undefined>;
  handleApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => Promise<void>;
  handleColumnsChange: (columns: Columns) => void;
  handlePlanChange: (taskId: string, plan: string) => void;
  handleQuestionsAnswered: (taskId: string, answers: string[]) => void;
  handleReject: (taskId: string) => Promise<void>;
  handleRetry: (taskId: string) => Promise<void>;
  handleReviewModeChange: (mode: "manual" | "auto") => void;
  handleRun: (taskId: string) => Promise<void>;
  localColumns: Columns;
}

async function requireAccepted(response: Response, fallback: string) {
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    throw new Error(error.success ? error.data.message : fallback);
  }

  const accepted = acceptedCommandResponseSchema.safeParse(payload);
  if (accepted.success && !accepted.data.accepted) {
    throw new Error(
      "The server did not accept this action. Refresh the board and try again."
    );
  }
}

function taskPendingApprovals(task: Task) {
  return (
    task.pendingApprovals ??
    (task.pendingApproval ? [task.pendingApproval] : [])
  );
}

async function submitTaskApproval({
  answers,
  boardId,
  plan,
  sessionId,
  task,
}: {
  answers: string[];
  boardId: string;
  plan: string;
  sessionId?: string;
  task: Task;
}) {
  const taskSessionId = task.run?.sessionId ?? task.runId ?? sessionId;
  const pendingApprovals = taskPendingApprovals(task);
  const permission = pendingApprovals.find(
    (entry) => entry.kind === "permission"
  );
  if (permission) {
    if (!permission.requestId) {
      throw new Error(
        "This permission request has expired. Refresh the board to load the latest request."
      );
    }
    if (!taskSessionId) {
      throw new Error(
        "This permission request has no provider session. Refresh the board and try again."
      );
    }
    await requireAccepted(
      await fetch(`/api/tasks/${encodeURIComponent(taskSessionId)}/approve`, {
        body: JSON.stringify({ requestID: permission.requestId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      "Could not approve this permission request. Try again."
    );
    return;
  }

  if (pendingApprovals.some((entry) => entry.kind === "question")) {
    throw new Error(
      "Answer the pending question in this card before continuing."
    );
  }
  if (task.outcome !== "awaiting_review") {
    throw new Error(
      "No active approval request was found. Refresh the board and try again."
    );
  }

  const planText = plan || task.plan || task.title;
  await requireAccepted(
    await fetch(
      `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(task.id)}/finalize-review`,
      {
        body: JSON.stringify({
          answers,
          plan: planText,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    ),
    "Could not finalize this plan. Your edits are still on the card; try again."
  );
}

async function submitTaskRejection({
  boardId,
  sessionId,
  task,
}: {
  boardId: string;
  sessionId?: string;
  task: Task;
}) {
  const taskSessionId = task.run?.sessionId ?? task.runId ?? sessionId;
  const pendingApprovals = taskPendingApprovals(task);
  const permission = pendingApprovals.find(
    (entry) => entry.kind === "permission"
  );
  if (permission) {
    if (!permission.requestId) {
      throw new Error(
        "This permission request has expired. Refresh the board to load the latest request."
      );
    }
    if (!taskSessionId) {
      throw new Error(
        "This permission request has no provider session. Refresh the board and try again."
      );
    }
    await requireAccepted(
      await fetch(`/api/tasks/${encodeURIComponent(taskSessionId)}/reject`, {
        body: JSON.stringify({ requestID: permission.requestId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      "Could not reject this permission request. Try again."
    );
    return;
  }

  const question = pendingApprovals.find((entry) => entry.kind === "question");
  if (question?.requestId) {
    if (!taskSessionId) {
      throw new Error(
        "This question has no provider session. Refresh the board and try again."
      );
    }
    await requireAccepted(
      await fetch(
        `/api/tasks/${encodeURIComponent(taskSessionId)}/questions/${encodeURIComponent(question.requestId)}/reject`,
        { method: "POST" }
      ),
      "Could not reject this question. Try again."
    );
    return;
  }
  if (task.outcome !== "awaiting_review") {
    throw new Error(
      "No active request was found to reject. Refresh the board and try again."
    );
  }

  await requireAccepted(
    await fetch(
      `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(task.id)}/reject-review`,
      { method: "POST" }
    ),
    "Could not reject this plan. Your task remains on the board; try again."
  );
}

/** Shared board commands and state for desktop and mobile lane views. */
export function useKanbanCardActions({
  boardId,
  columns,
  onUpdateColumns,
  sessionId,
}: {
  boardId: string;
  columns: Columns;
  onUpdateColumns?: (boardId: string, columns: Columns) => void;
  sessionId?: string | undefined;
}): KanbanCardActions {
  const [localColumns, setLocalColumns] = useState<Columns>(columns);
  const [actionStates, setActionStates] = useState<
    Record<string, KanbanTaskActionState | undefined>
  >({});
  const { updateBoardReviewMode } = useWorkspace();

  // Server events own lifecycle columns. The hook keeps no optimistic lifecycle
  // transitions that could leave a card missing after a rejected command.
  useEffect(() => {
    setLocalColumns(columns);
  }, [columns]);

  useEffect(() => {
    const approvalTaskIds = new Set(
      (columns.approve ?? []).map((task) => task.id)
    );
    const taskIdsToClear = Object.entries(actionStates)
      .filter(
        ([taskId, state]) =>
          state?.awaitingEvent && !approvalTaskIds.has(taskId)
      )
      .map(([taskId]) => taskId);
    if (taskIdsToClear.length === 0) {
      return;
    }

    setActionStates((current) => {
      const next = { ...current };
      for (const taskId of taskIdsToClear) {
        if (next[taskId]?.awaitingEvent) {
          delete next[taskId];
        }
      }
      return next;
    });
  }, [actionStates, columns]);

  const setTaskActionState = useCallback(
    (taskId: string, state: KanbanTaskActionState | undefined) => {
      setActionStates((current) => ({ ...current, [taskId]: state }));
    },
    []
  );

  const handleColumnsChange = useCallback(
    (nextColumns: Columns) => {
      setLocalColumns(nextColumns);

      onUpdateColumns?.(boardId, nextColumns);
    },
    [boardId, onUpdateColumns]
  );

  const handleApprove = useCallback(
    async (taskId: string, plan: string, answers: string[]) => {
      const task = (localColumns.approve ?? []).find(
        (candidate: Task) => candidate.id === taskId
      );
      if (!task) {
        setTaskActionState(taskId, {
          error:
            "This approval is no longer on the board. Refresh and try again.",
        });
        return;
      }
      if (!sessionId && task.outcome !== "awaiting_review") {
        setTaskActionState(taskId, {
          error: "This board has no active session to approve.",
        });
        return;
      }

      setTaskActionState(taskId, { pending: "approve" });
      posthog.capture("kanban_review_approve_start", {
        boardId,
        hasAnswers: answers.some((answer) => answer.length > 0),
        hasPlan: !!plan,
        sessionId,
        taskId,
      });

      try {
        await submitTaskApproval({
          answers,
          boardId,
          plan,
          sessionId,
          task,
        });

        setTaskActionState(taskId, {
          awaitingEvent: true,
          message: "Request accepted. Waiting for the agent to continue…",
        });
        posthog.capture("kanban_review_approve_success", {
          boardId,
          sessionId,
          taskId,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not approve this task. Try again.";
        setTaskActionState(taskId, { error: message });
        posthog.capture("kanban_review_approve_error", {
          boardId,
          error: message,
          sessionId,
          taskId,
        });
      }
    },
    [boardId, localColumns, sessionId, setTaskActionState]
  );

  const handleReject = useCallback(
    async (taskId: string) => {
      const task = (localColumns.approve ?? []).find(
        (candidate: Task) => candidate.id === taskId
      );
      if (!task) {
        setTaskActionState(taskId, {
          error:
            "This approval is no longer on the board. Refresh and try again.",
        });
        return;
      }
      if (!sessionId && task.outcome !== "awaiting_review") {
        setTaskActionState(taskId, {
          error: "This board has no active session to reject.",
        });
        return;
      }

      setTaskActionState(taskId, { pending: "reject" });
      try {
        await submitTaskRejection({ boardId, sessionId, task });

        setTaskActionState(taskId, {
          awaitingEvent: true,
          message: "Request accepted. Waiting for the board to update…",
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not reject this task. Try again.";
        setTaskActionState(taskId, { error: message });
        posthog.capture("kanban_review_reject_error", {
          boardId,
          error: message,
          sessionId,
          taskId,
        });
      }
    },
    [boardId, localColumns, sessionId, setTaskActionState]
  );

  const runTaskCommand = useCallback(
    async (taskId: string, action: "run" | "retry") => {
      const task = Object.values(localColumns)
        .flat()
        .find((candidate) => candidate.id === taskId);
      if (!task?.promptInput) {
        setTaskActionState(taskId, {
          error:
            "This task does not have a saved prompt, so it cannot be started again.",
        });
        return;
      }

      setTaskActionState(taskId, { pending: action });
      try {
        const response = await fetch(
          `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
          { method: "POST" }
        );
        const payload: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          const error = apiErrorSchema.safeParse(payload);
          throw new Error(
            error.success
              ? error.data.message
              : `Could not ${action} this task. Try again.`
          );
        }

        const command = boardTaskCommandResponseSchema.safeParse(payload);
        if (!command.success) {
          throw new Error(
            "The server returned an invalid task response. Refresh the board before trying again."
          );
        }
        if (command.data.status === "already_running") {
          setTaskActionState(taskId, {
            message: "This task is already running.",
          });
          return;
        }
        setTaskActionState(taskId, undefined);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `Could not ${action} this task. Try again.`;
        setTaskActionState(taskId, { error: message });
      }
    },
    [boardId, localColumns, setTaskActionState]
  );

  const handleRun = useCallback(
    (taskId: string) => runTaskCommand(taskId, "run"),
    [runTaskCommand]
  );

  const handleRetry = useCallback(
    (taskId: string) => runTaskCommand(taskId, "retry"),
    [runTaskCommand]
  );

  const handlePlanChange = useCallback(
    (_taskId: string, plan: string) => {
      posthog.capture("kanban_review_plan_updated", {
        boardId,
        planLength: plan.length,
      });
    },
    [boardId]
  );

  const handleQuestionsAnswered = useCallback(
    (_taskId: string, answers: string[]) => {
      posthog.capture("kanban_review_questions_answered", {
        answerCount: answers.length,
        boardId,
      });
    },
    [boardId]
  );

  const handleReviewModeChange = useCallback(
    (mode: "manual" | "auto") => {
      posthog.capture("kanban_review_mode_changed", { boardId, mode });
      updateBoardReviewMode(boardId, mode);
    },
    [boardId, updateBoardReviewMode]
  );

  return {
    actionStates,
    handleApprove,
    handleColumnsChange,
    handlePlanChange,
    handleQuestionsAnswered,
    handleReject,
    handleRetry,
    handleRun,
    handleReviewModeChange,
    localColumns,
  };
}
