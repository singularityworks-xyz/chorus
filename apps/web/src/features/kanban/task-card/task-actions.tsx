"use client";

import type { Task } from "@chorus/contracts";
import { LoaderIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KanbanTaskActionState } from "../hooks/use-kanban-card-actions";
import { FilePill } from "./diff-summary";

interface TaskCardQueueControlsProps {
  actionState?: KanbanTaskActionState;
  buttonState: {
    disabled: boolean;
    label: string;
    title: string;
  };
  onRun(): void | Promise<void>;
  showPlay: boolean;
  task: Task;
}

export function TaskCardQueueControls({
  actionState,
  buttonState,
  onRun,
  showPlay,
  task,
}: TaskCardQueueControlsProps) {
  if (!showPlay) {
    return null;
  }

  return (
    <>
      {task.taggedFiles && task.taggedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {task.taggedFiles.map((file) => (
            <FilePill key={file} path={file} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-end pt-0.5">
        <button
          className={cn(
            "flex items-center gap-1.5 rounded-xs border border-white/6 bg-white/6 px-2.5 py-1.5",
            "font-medium text-[0.7rem] text-white/50",
            "transition-all duration-150",
            "hover:border-emerald-500/20 hover:bg-emerald-500/12 hover:text-emerald-400",
            "active:scale-[0.97]"
          )}
          disabled={buttonState.disabled}
          onClick={onRun}
          title={buttonState.title}
          type="button"
        >
          {actionState?.pending === "run" ? (
            <LoaderIcon className="size-3 animate-spin" />
          ) : (
            <PlayIcon className="size-3 fill-current" />
          )}
          {buttonState.label}
        </button>
      </div>
    </>
  );
}

interface TaskCardFooterProps {
  actionState?: KanbanTaskActionState;
  buttonState: {
    disabled: boolean;
    label: string;
    title: string;
  };
  onRetry(): void | Promise<void>;
  showDone: boolean;
  showPlay: boolean;
  task: Task;
}

export function TaskCardFooter({
  actionState,
  buttonState,
  onRetry,
  showDone,
  showPlay,
  task,
}: TaskCardFooterProps) {
  return (
    <>
      {(showPlay || showDone) && !task.promptInput && (
        <p className="text-[0.66rem] text-white/35 leading-relaxed">
          This older task has no saved prompt, so it cannot be run or retried.
        </p>
      )}
      {actionState?.error && (
        <p
          className="rounded-xs border border-rose-500/20 bg-rose-500/8 px-2.5 py-2 text-[0.68rem] text-rose-300/90 leading-relaxed"
          role="alert"
        >
          {actionState.error}
        </p>
      )}
      {actionState?.message && (
        <p className="text-[0.68rem] text-white/45" role="status">
          {actionState.message}
        </p>
      )}
      {showDone && (
        <div className="flex items-center justify-end pt-0.5">
          <button
            className={cn(
              "flex items-center gap-1.5 rounded-xs border border-white/6 bg-white/4 px-2.5 py-1.5",
              "font-medium text-[0.7rem] text-white/30",
              "transition-all duration-150 hover:border-white/10 hover:bg-white/8 hover:text-white/55",
              "active:scale-[0.97]"
            )}
            disabled={buttonState.disabled}
            onClick={onRetry}
            title={buttonState.title}
            type="button"
          >
            {actionState?.pending === "retry" ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <RotateCcwIcon className="size-3" />
            )}
            {buttonState.label}
          </button>
        </div>
      )}
    </>
  );
}
