"use client";

import type { Columns, Task } from "@chorus/contracts";
import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { requireAcceptedCommand } from "../command-client";
import {
  type BoardTaskAction,
  requestBoardTaskCommand,
} from "../task-command-client";
import {
  hasObservedTaskCommand,
  isBoardTaskCommandBusy,
} from "../utils/board-task-state";
import {
  type AwaitingTaskActionEvent,
  shouldClearAwaitingTaskAction,
} from "../utils/task-approval-state";

const TASK_ACTION_TIMEOUT_MS = 10_000;
const TASK_COMMAND_EVENT_TIMEOUT_MS = 20_000;
const TASK_COMMAND_EVENT_TIMEOUT_MESSAGE =
  "The request was accepted, but the board has not confirmed it yet. Refresh the board to check its status before trying again.";

function taskActionErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "The request timed out. Refresh the board to check whether the action completed before retrying.";
  }
  if (error instanceof TypeError) {
    return "Could not reach Chorus. Check the connection and refresh the board before retrying.";
  }
  return error instanceof Error ? error.message : fallback;
}

export interface KanbanTaskActionState {
  awaitingEvent?: AwaitingTaskActionEvent;
  awaitingTaskCommandId?: string;
  awaitingTaskCommandStartedAt?: number;
  awaitingTaskCommandTimedOut?: boolean;
  error?: string;
  message?: string;
  pending?: "approve" | "reject" | "run" | "retry";
}

export interface KanbanCardActions {
  actionStates: Record<string, KanbanTaskActionState | undefined>;
  boardBusy: boolean;
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
  handleReviewModeChange: (mode: "manual" | "auto") => Promise<void>;
  handleRun: (taskId: string) => Promise<void>;
  localColumns: Columns;
  reviewMode: "manual" | "auto";
  reviewModeError: string | null;
  reviewModePending: boolean;
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
    await requireAcceptedCommand(
      await fetch(`/api/tasks/${encodeURIComponent(taskSessionId)}/approve`, {
        body: JSON.stringify({ requestID: permission.requestId }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
      }),
      {
        fallback: "Could not approve this permission request. Try again.",
      }
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
  await requireAcceptedCommand(
    await fetch(
      `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(task.id)}/finalize-review`,
      {
        body: JSON.stringify({
          answers,
          plan: planText,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
      }
    ),
    {
      fallback:
        "Could not finalize this plan. Your edits are still on the card; try again.",
    }
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
    await requireAcceptedCommand(
      await fetch(`/api/tasks/${encodeURIComponent(taskSessionId)}/reject`, {
        body: JSON.stringify({ requestID: permission.requestId }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
      }),
      { fallback: "Could not reject this permission request. Try again." }
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
    await requireAcceptedCommand(
      await fetch(
        `/api/tasks/${encodeURIComponent(taskSessionId)}/questions/${encodeURIComponent(question.requestId)}/reject`,
        {
          method: "POST",
          signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
        }
      ),
      { fallback: "Could not reject this question. Try again." }
    );
    return;
  }
  if (task.outcome !== "awaiting_review") {
    throw new Error(
      "No active request was found to reject. Refresh the board and try again."
    );
  }

  await requireAcceptedCommand(
    await fetch(
      `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(task.id)}/reject-review`,
      {
        method: "POST",
        signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
      }
    ),
    {
      fallback:
        "Could not reject this plan. Your task remains on the board; try again.",
    }
  );
}

/** Shared board commands and state for desktop and mobile lane views. */
export function useKanbanCardActions({
  boardId,
  columns,
  onUpdateColumns,
  reviewMode,
  sessionId,
}: {
  boardId: string;
  columns: Columns;
  onUpdateColumns: (boardId: string, columns: Columns) => void;
  reviewMode: "manual" | "auto";
  sessionId?: string | undefined;
}): KanbanCardActions {
  const [localColumns, setLocalColumns] = useState<Columns>(columns);
  const [localReviewMode, setLocalReviewMode] = useState(reviewMode);
  const [reviewModePending, setReviewModePending] = useState(false);
  const [reviewModeError, setReviewModeError] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<
    Record<string, KanbanTaskActionState | undefined>
  >({});
  const reviewModeRef = useRef(reviewMode);
  const reviewModeCommandRef = useRef(0);
  const inFlightTaskActionRef = useRef(new Set<string>());
  const inFlightBoardTaskCommandRef = useRef(false);
  const { updateBoardReviewMode } = useWorkspace();
  const boardBusy = isBoardTaskCommandBusy(localColumns, actionStates);

  // Server events own lifecycle columns. The hook keeps no optimistic lifecycle
  // transitions that could leave a card missing after a rejected command.
  useEffect(() => {
    setLocalColumns(columns);
  }, [columns]);

  useEffect(() => {
    reviewModeRef.current = reviewMode;
    setLocalReviewMode(reviewMode);
    setReviewModeError(null);
  }, [reviewMode]);

  useEffect(
    () => () => {
      reviewModeCommandRef.current += 1;
    },
    []
  );

  useEffect(() => {
    const approvalTasks = new Map(
      (columns.approve ?? []).map((task) => [task.id, task])
    );
    const taskIdsToClear = Object.entries(actionStates)
      .filter(
        ([taskId, state]) =>
          state?.awaitingEvent &&
          shouldClearAwaitingTaskAction(approvalTasks.get(taskId), state)
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

  useEffect(() => {
    const taskIdsToClear = Object.entries(actionStates)
      .filter(
        ([, state]) =>
          state?.awaitingTaskCommandId &&
          hasObservedTaskCommand(state.awaitingTaskCommandId, columns)
      )
      .map(([taskId]) => taskId);
    if (taskIdsToClear.length === 0) {
      return;
    }

    setActionStates((current) => {
      const next = { ...current };
      for (const taskId of taskIdsToClear) {
        if (next[taskId]?.awaitingTaskCommandId) {
          delete next[taskId];
        }
      }
      return next;
    });
  }, [actionStates, columns]);

  useEffect(() => {
    const waitingCommands = Object.entries(actionStates).flatMap(
      ([taskId, state]) =>
        state?.awaitingTaskCommandId && state.awaitingTaskCommandStartedAt
          ? [
              {
                taskId,
                commandId: state.awaitingTaskCommandId,
                startedAt: state.awaitingTaskCommandStartedAt,
              },
            ]
          : []
    );
    if (waitingCommands.length === 0) {
      return;
    }

    const timers = waitingCommands.map(({ taskId, commandId, startedAt }) =>
      setTimeout(
        () => {
          setActionStates((current) => {
            const state = current[taskId];
            if (
              state?.awaitingTaskCommandId !== commandId ||
              state.awaitingTaskCommandStartedAt !== startedAt
            ) {
              return current;
            }
            return {
              ...current,
              [taskId]: {
                awaitingTaskCommandId: commandId,
                awaitingTaskCommandTimedOut: true,
                error: TASK_COMMAND_EVENT_TIMEOUT_MESSAGE,
              },
            };
          });
        },
        Math.max(0, startedAt + TASK_COMMAND_EVENT_TIMEOUT_MS - Date.now())
      )
    );

    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [actionStates]);

  const setTaskActionState = useCallback(
    (taskId: string, state: KanbanTaskActionState | undefined) => {
      setActionStates((current) => ({ ...current, [taskId]: state }));
    },
    []
  );

  const handleColumnsChange = useCallback(
    (nextColumns: Columns) => {
      setLocalColumns(nextColumns);

      onUpdateColumns(boardId, nextColumns);
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
          hasPlan: !!plan,
          sessionId,
          taskId,
        });
        await submitTaskApproval({
          answers,
          boardId,
          plan,
          sessionId,
          task,
        });

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
    [boardId, localColumns, sessionId, setTaskActionState]
  );

  const runTaskCommand = useCallback(
    async (taskId: string, action: BoardTaskAction) => {
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

      if (inFlightTaskActionRef.current.has(taskId)) {
        return;
      }
      if (
        inFlightBoardTaskCommandRef.current ||
        isBoardTaskCommandBusy(localColumns, actionStates)
      ) {
        return;
      }
      inFlightTaskActionRef.current.add(taskId);
      inFlightBoardTaskCommandRef.current = true;
      setTaskActionState(taskId, { pending: action });
      try {
        const command = await requestBoardTaskCommand(boardId, taskId, action);
        setTaskActionState(taskId, {
          awaitingTaskCommandId: command.taskId,
          awaitingTaskCommandStartedAt: Date.now(),
          message:
            command.status === "already_running"
              ? "This task is already running. Waiting for the board to update…"
              : "Request accepted. Waiting for the board to update…",
        });
      } catch (error) {
        const message = taskActionErrorMessage(
          error,
          `Could not ${action} this task. Try again.`
        );
        setTaskActionState(taskId, { error: message });
      } finally {
        inFlightTaskActionRef.current.delete(taskId);
        inFlightBoardTaskCommandRef.current = false;
      }
    },
    [actionStates, boardId, localColumns, setTaskActionState]
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
    async (mode: "manual" | "auto") => {
      const commandId = reviewModeCommandRef.current + 1;
      reviewModeCommandRef.current = commandId;
      const previousMode = reviewModeRef.current;
      reviewModeRef.current = mode;
      setLocalReviewMode(mode);
      setReviewModePending(true);
      setReviewModeError(null);
      posthog.capture("kanban_review_mode_changed", { boardId, mode });

      try {
        await updateBoardReviewMode(boardId, mode);
      } catch {
        if (reviewModeCommandRef.current === commandId) {
          reviewModeRef.current = previousMode;
          setLocalReviewMode(previousMode);
          setReviewModeError(
            "Could not save the review mode. Your previous setting was restored; try again."
          );
        }
      } finally {
        if (reviewModeCommandRef.current === commandId) {
          setReviewModePending(false);
        }
      }
    },
    [boardId, updateBoardReviewMode]
  );

  return {
    actionStates,
    boardBusy,
    handleApprove,
    handleColumnsChange,
    handlePlanChange,
    handleQuestionsAnswered,
    handleReject,
    handleRetry,
    handleRun,
    handleReviewModeChange,
    localColumns,
    reviewMode: localReviewMode,
    reviewModeError,
    reviewModePending,
  };
}
