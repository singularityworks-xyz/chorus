"use client";

import type { Task } from "@chorus/contracts";
import { cn } from "@/lib/utils";
import { AgentOutputCard } from "../agent-output/agent-output-card";
import { KanbanItem, KanbanItemHandle } from "../components/kanban";
import { QuestionCard } from "../components/question-card";
import type { KanbanTaskActionState } from "../task-actions/types";
import { getBoardTaskCommandButtonState } from "../utils/board-task-state";
import {
  getPendingQuestionApprovals,
  hasPendingQuestion,
} from "../utils/task-approval-state";
import { getTaskDiffSummary, TaskCardDoneSummary } from "./diff-summary";
import { TaskPlanDialog } from "./plan-dialog";
import { TaskCardReviewActions, TaskCardReviewStatus } from "./review-actions";
import { TaskCardReviewEditor } from "./review-editor";
import { TaskCardFooter, TaskCardQueueControls } from "./task-actions";
import { useTaskCardReview } from "./use-task-card-review";

interface TaskCardProps {
  actionState?: KanbanTaskActionState;
  asHandle?: boolean;
  boardBusy: boolean;
  boardId: string;
  draggable?: boolean;
  onApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => void | Promise<void>;
  onPlanChange: (taskId: string, plan: string) => void;
  onQuestionsAnswered: (taskId: string, answers: string[]) => void;
  onReject: (taskId: string) => void | Promise<void>;
  onRetry: (taskId: string) => void | Promise<void>;
  onRun: (taskId: string) => void | Promise<void>;
  reviewMode?: "manual" | "auto";
  showApprovalControls?: boolean;
  showDone?: boolean;
  showOutput?: boolean;
  showPlay?: boolean;
  task: Task;
}

export function TaskCard({
  boardBusy,
  boardId,
  task,
  asHandle,
  draggable,
  showOutput,
  showDone,
  showApprovalControls,
  showPlay,
  actionState,
  reviewMode = "auto",
  onApprove,
  onReject,
  onPlanChange,
  onQuestionsAnswered,
  onRetry,
  onRun,
}: TaskCardProps) {
  const { changedFiles, diffTotals } = getTaskDiffSummary(task);
  const hasQuestion = hasPendingQuestion(task);
  const {
    editedPlan,
    handleApproveClick,
    handleQuestionChange,
    isManualReview,
    questionAnswers,
    setEditedPlan,
    setShowPlanPopup,
    showPlanPopup,
    showReviewActions,
  } = useTaskCardReview({
    onApprove,
    onPlanChange,
    onQuestionsAnswered,
    showApprovalControls,
    task,
  });

  const runButton = getBoardTaskCommandButtonState(
    "run",
    actionState,
    boardBusy,
    Boolean(task.promptInput)
  );
  const retryButton = getBoardTaskCommandButtonState(
    "retry",
    actionState,
    boardBusy,
    Boolean(task.promptInput)
  );

  const content = (
    <div
      className={cn(
        "group flex flex-col gap-3 rounded-sm border border-border/50 bg-card p-3.5 shadow-sm",
        "transition-all duration-200 hover:border-border hover:shadow-md",
        "dark:border-white/8 dark:bg-white/2.5"
      )}
    >
      <span
        className={cn(
          "font-medium text-[0.85rem] text-foreground leading-snug dark:text-white/85",
          showDone && "line-through decoration-2 decoration-white/30"
        )}
      >
        {task.title}
      </span>

      <TaskCardReviewEditor
        editedPlan={editedPlan}
        isManualReview={isManualReview ?? false}
        onExpandPlan={() => setShowPlanPopup(true)}
        onPlanChange={setEditedPlan}
        onQuestionChange={handleQuestionChange}
        questionAnswers={questionAnswers}
        task={task}
      />

      <TaskCardReviewStatus
        reviewMode={reviewMode}
        showApprovalControls={showApprovalControls ?? false}
        task={task}
      />

      <TaskCardDoneSummary
        changedFiles={changedFiles}
        diffTotals={diffTotals}
        showDone={showDone ?? false}
        task={task}
      />

      <TaskCardQueueControls
        actionState={actionState}
        buttonState={runButton}
        onRun={() => onRun(task.id)}
        showPlay={showPlay ?? false}
        task={task}
      />

      {showApprovalControls && hasQuestion && task.run?.sessionId && (
        <QuestionCard
          requests={getPendingQuestionApprovals(task)}
          sessionID={task.run.sessionId}
        />
      )}

      <TaskCardReviewActions
        actionState={actionState}
        isManualReview={isManualReview ?? false}
        onApprove={handleApproveClick}
        onReject={() => onReject(task.id)}
        showReviewActions={showReviewActions ?? false}
      />

      <TaskCardFooter
        actionState={actionState}
        buttonState={retryButton}
        onRetry={() => onRetry(task.id)}
        showDone={showDone ?? false}
        showPlay={showPlay ?? false}
        task={task}
      />
    </div>
  );

  const contentNode =
    asHandle && draggable ? (
      <KanbanItemHandle>{content}</KanbanItemHandle>
    ) : (
      content
    );

  return (
    <KanbanItem data-task-id={task.id} disabled={!draggable} value={task.id}>
      {showOutput ? (
        <>
          {contentNode}
          <div className="flex">
            <div className="ml-5 flex flex-col items-center">
              <div className="h-2 w-px bg-linear-to-b from-white/5 to-white/15" />
              <div className="size-1.5 rounded-full border border-white/20 bg-white/10" />
              <div className="h-1.5 w-px bg-linear-to-b from-white/15 to-white/5" />
            </div>
          </div>
          <AgentOutputCard
            boardId={boardId}
            isActive={showOutput}
            run={task.run}
            taskId={task.id}
            taskTitle={task.title}
          />
        </>
      ) : (
        contentNode
      )}
      <TaskPlanDialog
        onChange={setEditedPlan}
        onClose={() => setShowPlanPopup(false)}
        open={showPlanPopup}
        plan={editedPlan}
      />
    </KanbanItem>
  );
}
