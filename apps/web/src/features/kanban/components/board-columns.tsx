"use client";

import type { Task } from "@chorus/contracts";
import {
  ArchiveIcon,
  CheckCircle2Icon,
  CogIcon,
  EyeIcon,
  ListTodoIcon,
  LoaderIcon,
  PlusIcon,
  SearchCheckIcon,
} from "lucide-react";
import { ResizablePanel } from "@/components/ui/resizable";
import type { KanbanTaskActionState } from "@/features/kanban/hooks/use-kanban-card-actions";
import { cn } from "@/lib/utils";
import { KanbanColumn, KanbanColumnContent } from "./kanban";
import { computeDiffTotals, TaskCard } from "./task-card";

const COLUMNS: Record<
  string,
  {
    title: string;
    icon: React.ReactNode;
    accent: string;
    emptyIcon: React.ComponentType<{ className?: string }>;
    emptyHeadline: string;
    emptyHint: string;
  }
> = {
  queue: {
    title: "Queue",
    icon: <ListTodoIcon className="size-4.5 text-white/35" />,
    accent: "bg-white/24",
    emptyIcon: ListTodoIcon,
    emptyHeadline: "Nothing lined up yet",
    emptyHint: 'Hit "Create Task" to give the agents something to chew on.',
  },
  in_progress: {
    title: "In Progress",
    icon: <LoaderIcon className="size-4.5 text-sky-400/60" />,
    accent: "bg-sky-400/55",
    emptyIcon: CogIcon,
    emptyHeadline: "All quiet on the agent front",
    emptyHint: "Agents will appear here once a task is running.",
  },
  approve: {
    title: "Review",
    icon: <EyeIcon className="size-4.5 text-amber-400/60" />,
    accent: "bg-amber-400/55",
    emptyIcon: SearchCheckIcon,
    emptyHeadline: "Nothing needs your eyes",
    emptyHint: "Completed tasks awaiting a human call will land here.",
  },
  done: {
    title: "Done",
    icon: <CheckCircle2Icon className="size-4.5 text-emerald-400/60" />,
    accent: "bg-emerald-400/55",
    emptyIcon: ArchiveIcon,
    emptyHeadline: "The slate is clean",
    emptyHint: "Shipped work stacks up here. Start something great.",
  },
};

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

function ReviewModeToggle({
  pending,
  reviewMode,
  onToggle,
}: {
  pending: boolean;
  reviewMode: "manual" | "auto";
  onToggle: (mode: "manual" | "auto") => void;
}) {
  const modeLabel = reviewMode === "manual" ? "Manual" : "Auto";
  let toggleTitle = "Switch to manual review";
  if (pending) {
    toggleTitle = "Saving review mode";
  } else if (reviewMode === "manual") {
    toggleTitle = "Switch to auto-accept";
  }

  return (
    <button
      aria-busy={pending}
      aria-label={pending ? "Saving review mode" : `${modeLabel} review mode`}
      className="flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 transition-colors hover:bg-white/5"
      disabled={pending}
      onClick={() => onToggle(reviewMode === "manual" ? "auto" : "manual")}
      title={toggleTitle}
      type="button"
    >
      <span
        className={cn(
          "font-medium text-[0.6rem] uppercase tracking-wider transition-colors",
          reviewMode === "manual" ? "text-amber-400" : "text-white/25"
        )}
      >
        {pending ? "Saving…" : modeLabel}
      </span>
      <span
        className={cn(
          "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-all duration-200",
          reviewMode === "manual"
            ? "bg-amber-500/35 shadow-[0_0_8px_rgba(251,191,36,0.25)]"
            : "bg-white/10"
        )}
      >
        <span
          className={cn(
            "absolute size-2.5 rounded-full shadow-sm transition-all duration-200",
            reviewMode === "manual"
              ? "left-[calc(100%-2px)] -translate-x-full bg-amber-400"
              : "left-0.5 bg-white/35"
          )}
        />
      </span>
    </button>
  );
}

function ColumnHeader({
  columnId,
  tasks,
  reviewMode,
  reviewModeError,
  reviewModePending,
  onReviewModeChange,
}: {
  columnId: string;
  tasks: Task[];
  reviewMode: "manual" | "auto";
  reviewModeError: string | null;
  reviewModePending: boolean;
  onReviewModeChange: (mode: "manual" | "auto") => void;
}) {
  const col = COLUMNS[columnId];
  const isReview = columnId === "approve";
  const isDone = columnId === "done";

  const doneTotals = isDone
    ? tasks.reduce(
        (acc, task) => {
          const totals = task.run
            ? computeDiffTotals(task.run.steps)
            : {
                added: task.linesAdded ?? 0,
                removed: task.linesRemoved ?? 0,
                fileCount: task.changedFiles?.length ?? 0,
              };
          return {
            added: acc.added + totals.added,
            removed: acc.removed + totals.removed,
            fileCount: acc.fileCount + totals.fileCount,
          };
        },
        { added: 0, removed: 0, fileCount: 0 }
      )
    : null;

  return (
    <>
      <div className="flex items-center gap-2 px-1 pt-0.5 pb-0.5">
        {col.icon}
        <h3 className="truncate font-semibold text-[0.7rem] text-muted-foreground uppercase tracking-widest dark:text-white/40">
          {col.title}
        </h3>
        <div className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-white/6 font-semibold text-[10px] text-white/45">
          {tasks.length}
        </div>
        {isDone && doneTotals && doneTotals.fileCount > 0 && (
          <span className="shrink-0 rounded-xs bg-white/5 px-1.5 py-0.5 font-mono text-[0.55rem] text-white/35">
            {doneTotals.fileCount} file{doneTotals.fileCount === 1 ? "" : "s"}
          </span>
        )}
        {isReview && (
          <ReviewModeToggle
            onToggle={onReviewModeChange}
            pending={reviewModePending}
            reviewMode={reviewMode}
          />
        )}
      </div>
      {isReview && reviewModeError && (
        <p className="px-1 text-[0.62rem] text-rose-300/85" role="alert">
          {reviewModeError}
        </p>
      )}
    </>
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
}: {
  boardBusy: boolean;
  boardId: string;
  columnId: string;
  tasks: Task[];
  reviewMode: "manual" | "auto";
  actionStates?: Record<string, KanbanTaskActionState | undefined>;
  onApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => void | Promise<void>;
  onReject: (taskId: string) => void | Promise<void>;
  onRetry: (taskId: string) => void | Promise<void>;
  onRun: (taskId: string) => void | Promise<void>;
  onPlanChange: (taskId: string, plan: string) => void;
  onQuestionsAnswered: (taskId: string, answers: string[]) => void;
}) {
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

export function KanbanColumnRenderer({
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
}: {
  boardBusy: boolean;
  boardId: string;
  columnId: string;
  tasks: Task[];
  reviewMode: "manual" | "auto";
  reviewModeError: string | null;
  reviewModePending: boolean;
  onReviewModeChange: (mode: "manual" | "auto") => void;
  actionStates?: Record<string, KanbanTaskActionState | undefined>;
  onApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => void | Promise<void>;
  onReject: (taskId: string) => void | Promise<void>;
  onRetry: (taskId: string) => void | Promise<void>;
  onRun: (taskId: string) => void | Promise<void>;
  onCreateTask: () => void;
  onPlanChange: (taskId: string, plan: string) => void;
  onQuestionsAnswered: (taskId: string, answers: string[]) => void;
}) {
  return (
    <ResizablePanel
      className="flex min-w-0 flex-col"
      defaultSize={25}
      minSize={15}
    >
      <KanbanColumnBody
        actionStates={actionStates}
        boardBusy={boardBusy}
        boardId={boardId}
        columnId={columnId}
        onApprove={onApprove}
        onCreateTask={onCreateTask}
        onPlanChange={onPlanChange}
        onQuestionsAnswered={onQuestionsAnswered}
        onReject={onReject}
        onRetry={onRetry}
        onReviewModeChange={onReviewModeChange}
        onRun={onRun}
        reviewMode={reviewMode}
        reviewModeError={reviewModeError}
        reviewModePending={reviewModePending}
        tasks={tasks}
      />
    </ResizablePanel>
  );
}

// Shared lane content for the desktop card and stacked phone layout.
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
}: {
  boardBusy: boolean;
  boardId: string;
  columnId: string;
  tasks: Task[];
  reviewMode: "manual" | "auto";
  reviewModeError: string | null;
  reviewModePending: boolean;
  onReviewModeChange: (mode: "manual" | "auto") => void;
  actionStates?: Record<string, KanbanTaskActionState | undefined>;
  onApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => void | Promise<void>;
  onReject: (taskId: string) => void | Promise<void>;
  onRetry: (taskId: string) => void | Promise<void>;
  onRun: (taskId: string) => void | Promise<void>;
  onCreateTask: () => void;
  onPlanChange: (taskId: string, plan: string) => void;
  onQuestionsAnswered: (taskId: string, answers: string[]) => void;
}) {
  const col = COLUMNS[columnId];
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
