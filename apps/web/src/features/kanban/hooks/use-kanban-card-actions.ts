"use client";

import type { Columns, Task } from "@chorus/contracts";
import posthog from "posthog-js";
import { useCallback, useEffect, useState } from "react";
import { useKanbanHistory } from "@/features/kanban/hooks/use-kanban-history";
import { useWorkspace } from "@/features/workspace/workspace-context";

/**
 * The board's mutations, shared by every layout that renders a board.
 *
 * Approving a card is the primary human action in Chorus, so it has to work
 * wherever a board is shown. These handlers were inline in the React Flow node,
 * which meant the phone lane list could either duplicate them -- and drift --
 * or render approval buttons that silently do nothing. One hook, one
 * implementation, both layouts.
 */
export interface KanbanCardActions {
  handleApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => Promise<void>;
  handleColumnsChange: (columns: Columns) => void;
  handlePlanChange: (taskId: string, plan: string) => void;
  handleQuestionsAnswered: (taskId: string, answers: string[]) => void;
  handleReject: (taskId: string) => Promise<void>;
  handleReviewModeChange: (mode: "manual" | "auto") => void;
  localColumns: Columns;
}

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
  const kanbanHistory = useKanbanHistory();
  const { updateBoardReviewMode } = useWorkspace();

  // The socket is authoritative. Local state only exists so an optimistic column
  // change does not visibly revert between the drop and the event arriving.
  useEffect(() => {
    setLocalColumns(columns);
  }, [columns]);

  const handleColumnsChange = useCallback(
    (nextColumns: Columns) => {
      setLocalColumns((previousColumns) => {
        const doneTasks = nextColumns.done ?? [];
        const previousDoneTasks = previousColumns.done ?? [];

        if (doneTasks.length > previousDoneTasks.length) {
          const newDoneTask = doneTasks.at(-1);
          if (newDoneTask) {
            kanbanHistory.recordMove(previousColumns, nextColumns, newDoneTask);
          }
        }

        return nextColumns;
      });

      onUpdateColumns?.(boardId, nextColumns);
    },
    [boardId, kanbanHistory, onUpdateColumns]
  );

  const handleApprove = useCallback(
    async (taskId: string, plan: string, answers: string[]) => {
      const task = (localColumns.approve ?? []).find(
        (candidate: Task) => candidate.id === taskId
      );

      if (!sessionId) {
        posthog.capture("kanban_review_approve_error", {
          boardId,
          reason: "no_session",
        });
        return;
      }

      posthog.capture("kanban_review_approve_start", {
        boardId,
        hasAnswers: answers.some((a) => a.length > 0),
        hasPlan: !!plan,
        sessionId,
        taskId,
      });

      if (!task) {
        return;
      }

      // Move approve → in_progress immediately, so the card responds to the tap
      // rather than waiting on the network.
      const updatedTask: Task = {
        ...task,
        plan: plan || task.plan || task.title,
      };
      const nextColumns: Columns = {
        ...localColumns,
        approve: (localColumns.approve ?? []).filter(
          (candidate: Task) => candidate.id !== taskId
        ),
        in_progress: [...(localColumns.in_progress ?? []), updatedTask],
      };
      setLocalColumns(nextColumns);
      onUpdateColumns?.(boardId, nextColumns);

      try {
        const planText = plan || task.plan || task.title || "";
        const questionPairs =
          task.questions?.map((question: string, i: number) => ({
            answer: answers[i] ?? "",
            question,
          })) ?? [];

        const response = await fetch(
          `/api/tasks/${sessionId}/finalize-review`,
          {
            body: JSON.stringify({
              plan: planText,
              questions: questionPairs.length > 0 ? questionPairs : undefined,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }
        );

        if (!response.ok) {
          posthog.capture("kanban_review_finalize_failed", {
            boardId,
            sessionId,
            status: response.status,
            taskId,
          });
          return;
        }

        posthog.capture("kanban_review_finalize_success", {
          boardId,
          sessionId,
          taskId,
        });
      } catch (error) {
        posthog.capture("kanban_review_finalize_error", {
          boardId,
          error: error instanceof Error ? error.message : String(error),
          sessionId,
          taskId,
        });
      }
    },
    [boardId, localColumns, onUpdateColumns, sessionId]
  );

  const handleReject = useCallback(
    async (taskId: string) => {
      if (!sessionId) {
        posthog.capture("kanban_review_reject_error", {
          boardId,
          reason: "no_session",
        });
        return;
      }

      posthog.capture("kanban_review_reject_start", {
        boardId,
        sessionId,
        taskId,
      });

      const nextColumns: Columns = {
        ...localColumns,
        approve: (localColumns.approve ?? []).filter(
          (candidate: Task) => candidate.id !== taskId
        ),
      };
      setLocalColumns(nextColumns);
      onUpdateColumns?.(boardId, nextColumns);

      try {
        const response = await fetch(`/api/tasks/${sessionId}/abort`, {
          method: "POST",
        });

        if (!response.ok) {
          posthog.capture("kanban_review_abort_failed", {
            boardId,
            sessionId,
            status: response.status,
            taskId,
          });
          return;
        }

        posthog.capture("kanban_review_abort_success", {
          boardId,
          sessionId,
          taskId,
        });
      } catch (error) {
        posthog.capture("kanban_review_abort_error", {
          boardId,
          error: error instanceof Error ? error.message : String(error),
          sessionId,
          taskId,
        });
      }
    },
    [boardId, localColumns, onUpdateColumns, sessionId]
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
    handleApprove,
    handleColumnsChange,
    handlePlanChange,
    handleQuestionsAnswered,
    handleReject,
    handleReviewModeChange,
    localColumns,
  };
}
