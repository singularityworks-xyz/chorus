"use client";

import type { Task } from "@chorus/contracts";
import { useEffect, useState } from "react";
import { shouldShowReviewActions } from "../utils/task-approval-state";

interface UseTaskCardReviewOptions {
  onApprove(
    taskId: string,
    plan: string,
    answers: string[]
  ): void | Promise<void>;
  onPlanChange(taskId: string, plan: string): void;
  onQuestionsAnswered(taskId: string, answers: string[]): void;
  showApprovalControls?: boolean;
  task: Task;
}

export function useTaskCardReview({
  onApprove,
  onPlanChange,
  onQuestionsAnswered,
  showApprovalControls,
  task,
}: UseTaskCardReviewOptions) {
  const [editedPlan, setEditedPlan] = useState(task.plan ?? "");
  const [questionAnswers, setQuestionAnswers] = useState<string[]>(
    task.questionAnswers ?? task.questions?.map(() => "") ?? []
  );
  const [showPlanPopup, setShowPlanPopup] = useState(false);

  useEffect(() => {
    setEditedPlan(task.plan ?? "");
  }, [task.plan]);

  useEffect(() => {
    setQuestionAnswers(
      task.questionAnswers ?? task.questions?.map(() => "") ?? []
    );
  }, [task.questionAnswers, task.questions]);

  useEffect(() => {
    if (!showPlanPopup) {
      return;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowPlanPopup(false);
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [showPlanPopup]);

  const isManualReview = Boolean(
    showApprovalControls &&
      task.outcome === "awaiting_review" &&
      task.reviewApproved !== true
  );
  const showReviewActions = Boolean(
    showApprovalControls && shouldShowReviewActions(task)
  );

  function handleApproveClick() {
    if (!isManualReview) {
      onApprove(task.id, "", []);
      return;
    }
    if (editedPlan !== task.plan) {
      onPlanChange(task.id, editedPlan);
    }
    onApprove(task.id, editedPlan, questionAnswers);
  }

  function handleQuestionChange(index: number, value: string) {
    const answers = [...questionAnswers];
    answers[index] = value;
    setQuestionAnswers(answers);
    onQuestionsAnswered(task.id, answers);
  }

  return {
    editedPlan,
    handleApproveClick,
    handleQuestionChange,
    isManualReview,
    questionAnswers,
    setEditedPlan,
    setShowPlanPopup,
    showPlanPopup,
    showReviewActions,
  };
}
