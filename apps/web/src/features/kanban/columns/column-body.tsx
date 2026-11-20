"use client";

import { PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { KanbanColumn, KanbanColumnContent } from "../components/kanban";
import { TaskCard } from "../task-card/task-card";
import { COLUMN_CONFIG, ColumnHeader } from "./column-header";
import type { KanbanColumnProps, KanbanTaskListProps } from "./types";

function ColumnEmptyState({
  icon: Icon,
  headline,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  headline: string;
  hint: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <Icon className="size-8 text-zinc-800" />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-[0.75rem] text-white/30">{headline}</p>
        <p className="text-[0.68rem] text-white/18 leading-relaxed">{hint}</p>
      </div>
    </div>
  );
}

function TaskList({
  boardId,
  boardBusy,
  columnId,
  tasks,
  reviewMode,
  actionStates,
  onApprove,
  onReject,
  onPlanChange,
  onQuestionsAnswered,
  onRetry,
  onRun,
}: KanbanTaskListProps) {
  return tasks.map((task) => (
    <TaskCard
      actionState={actionStates?.[task.id]}
      asHandle
      boardBusy={boardBusy}
      boardId={boardId}
      draggable={columnId === "queue"}
      key={task.id}
      onApprove={onApprove}
      onPlanChange={onPlanChange}
      onQuestionsAnswered={onQuestionsAnswered}
      onReject={onReject}
      onRetry={onRetry}
      onRun={onRun}
      reviewMode={columnId === "approve" ? reviewMode : "auto"}
      showApprovalControls={columnId === "approve"}
      showDone={columnId === "done"}
      showOutput={columnId === "in_progress"}
      showPlay={columnId === "queue"}
      task={task}
    />
  ));
}

export function KanbanColumnBody({
  boardId,
  boardBusy,
  columnId,
  tasks,
  reviewMode,
  reviewModeError,
  reviewModePending,
  actionStates,
  onReviewModeChange,
  onApprove,
  onReject,
  onPlanChange,
  onQuestionsAnswered,
  onRetry,
  onRun,
  onCreateTask,
}: KanbanColumnProps) {
  const col = COLUMN_CONFIG[columnId];
  const isQueue = columnId === "queue";

  return (
    <div className="flex h-full min-w-0 flex-col p-1.5">
      <KanbanColumn value={columnId}>
        <div className="relative flex h-full min-w-0 flex-col gap-2.5 overflow-hidden rounded-sm border border-white/[0.04] bg-white/[0.015] p-3">
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-0 right-3 left-3 h-px rounded-full opacity-70",
              col.accent
            )}
          />
          <ColumnHeader
            columnId={columnId}
            onReviewModeChange={onReviewModeChange}
            reviewMode={reviewMode}
            reviewModeError={reviewModeError}
            reviewModePending={reviewModePending}
            tasks={tasks}
          />

          {isQueue && (
            <button
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-xs px-3 py-2.5",
                "bg-white font-semibold text-[0.8rem] text-black",
                "shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_2px_12px_rgba(255,255,255,0.08)]",
                "transition-all duration-150",
                "hover:bg-white/93 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.15),0_4px_20px_rgba(255,255,255,0.15)]",
                "active:scale-[0.98] active:shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_1px_6px_rgba(255,255,255,0.1)]"
              )}
              onClick={onCreateTask}
              type="button"
            >
              <PlusIcon className="size-3.5 shrink-0" />
              Create Task
            </button>
          )}

          {isQueue && boardBusy && (
            <p
              className="rounded-xs border border-amber-400/15 bg-amber-400/[0.06] px-2.5 py-2 text-[0.68rem] text-amber-100/70"
              role="status"
            >
              Finish or resolve current work before running or retrying another
              task.
            </p>
          )}

          <KanbanColumnContent
            className="nowheel custom-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1 pb-1"
            value={columnId}
          >
            {tasks.length === 0 ? (
              <ColumnEmptyState
                headline={col.emptyHeadline}
                hint={col.emptyHint}
                icon={col.emptyIcon}
              />
            ) : (
              <TaskList
                actionStates={actionStates}
                boardBusy={boardBusy}
                boardId={boardId}
                columnId={columnId}
                onApprove={onApprove}
                onPlanChange={onPlanChange}
                onQuestionsAnswered={onQuestionsAnswered}
                onReject={onReject}
                onRetry={onRetry}
                onRun={onRun}
                reviewMode={reviewMode}
                tasks={tasks}
              />
            )}
          </KanbanColumnContent>
        </div>
      </KanbanColumn>
    </div>
  );
}
