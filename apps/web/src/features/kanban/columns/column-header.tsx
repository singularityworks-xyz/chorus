import type { WorkspaceColumnId } from "@chorus/contracts";
import {
  ArchiveIcon,
  CheckCircle2Icon,
  CogIcon,
  EyeIcon,
  ListTodoIcon,
  LoaderIcon,
  SearchCheckIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { computeDiffTotals } from "../task-card/diff-summary";
import type { KanbanColumnProps } from "./types";

export const COLUMN_CONFIG: Record<
  WorkspaceColumnId,
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

function ReviewModeToggle({
  pending,
  reviewMode,
  onToggle,
}: {
  pending: boolean;
  reviewMode: KanbanColumnProps["reviewMode"];
  onToggle: (mode: KanbanColumnProps["reviewMode"]) => void;
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

export function ColumnHeader({
  columnId,
  tasks,
  reviewMode,
  reviewModeError,
  reviewModePending,
  onReviewModeChange,
}: Pick<
  KanbanColumnProps,
  | "columnId"
  | "onReviewModeChange"
  | "reviewMode"
  | "reviewModeError"
  | "reviewModePending"
  | "tasks"
>) {
  const col = COLUMN_CONFIG[columnId];
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
