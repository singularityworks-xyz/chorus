"use client";

import type { Columns, WorkspaceColumnId } from "@chorus/contracts";
import posthog from "posthog-js";
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-context";
import type { KanbanCardActions } from "./types";
import { useBoardTaskCommands } from "./use-board-task-commands";
import { useReviewMode } from "./use-review-mode";
import { useTaskActionState } from "./use-task-action-state";
import { useTaskApprovalActions } from "./use-task-approval-actions";

export type { KanbanCardActions, KanbanTaskActionState } from "./types";

export function useKanbanCardActions({
  boardId,
  columns,
  reviewMode,
  sessionId,
}: {
  boardId: string;
  columns: Columns;
  reviewMode: "manual" | "auto";
  sessionId?: string | undefined;
}): KanbanCardActions {
  const [localColumns, setLocalColumns] = useState<Columns>(columns);
  const { reorderBoardTask } = useWorkspace();
  const actionState = useTaskActionState(columns, localColumns);
  const approvalActions = useTaskApprovalActions({
    boardId,
    columns: localColumns,
    inFlightTaskActionRef: actionState.inFlightTaskActionRef,
    sessionId,
    setTaskActionState: actionState.setTaskActionState,
  });
  const taskCommands = useBoardTaskCommands({
    actionStates: actionState.actionStates,
    boardId,
    columns: localColumns,
    inFlightBoardTaskCommandRef: actionState.inFlightBoardTaskCommandRef,
    inFlightTaskActionRef: actionState.inFlightTaskActionRef,
    setTaskActionState: actionState.setTaskActionState,
  });
  const localReview = useReviewMode(boardId, reviewMode);

  useEffect(() => {
    setLocalColumns(columns);
  }, [columns]);

  const handleReorderTask = useCallback(
    (
      taskId: string,
      column: WorkspaceColumnId,
      beforeTaskId: string | null
    ) => {
      reorderBoardTask(boardId, taskId, column, beforeTaskId).catch(
        () => undefined
      );
    },
    [boardId, reorderBoardTask]
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

  return {
    actionStates: actionState.actionStates,
    boardBusy: actionState.boardBusy,
    ...approvalActions,
    handlePlanChange,
    handleQuestionsAnswered,
    handleReorderTask,
    ...taskCommands,
    handleReviewModeChange: localReview.handleReviewModeChange,
    localColumns,
    reviewMode: localReview.reviewMode,
    reviewModeError: localReview.reviewModeError,
    reviewModePending: localReview.reviewModePending,
  };
}
