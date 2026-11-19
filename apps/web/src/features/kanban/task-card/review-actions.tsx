"use client";

import type { Task } from "@chorus/contracts";
import { CheckIcon, LoaderIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KanbanTaskActionState } from "../task-actions/types";
import { ChangedFileRow } from "./diff-summary";

interface TaskCardReviewStatusProps {
  reviewMode: "manual" | "auto";
  showApprovalControls: boolean;
  task: Task;
}

export function TaskCardReviewStatus({
  reviewMode,
  showApprovalControls,
  task,
}: TaskCardReviewStatusProps) {
  return (
    <>
      {showApprovalControls &&
        task.outcome === "awaiting_review" &&
        task.reviewApproved === true && (
          <p className="border-white/5 border-t pt-2.5 text-[0.7rem] text-emerald-300/75">
            Implementation accepted. Waiting for task activity…
          </p>
        )}
      {showApprovalControls &&
        reviewMode === "auto" &&
        task.changedFiles &&
        task.changedFiles.length > 0 && (
          <div className="flex flex-col gap-1 border-white/5 border-t pt-2.5">
            {task.changedFiles.map((file) => (
              <ChangedFileRow file={file} key={file.path} />
            ))}
          </div>
        )}
    </>
  );
}

interface TaskCardReviewActionsProps {
  actionState?: KanbanTaskActionState;
  isManualReview: boolean;
  onApprove(): void;
  onReject(): void | Promise<void>;
  showReviewActions: boolean;
}

export function TaskCardReviewActions({
  actionState,
  isManualReview,
  onApprove,
  onReject,
  showReviewActions,
}: TaskCardReviewActionsProps) {
  if (!showReviewActions) {
    return null;
  }

  return (
    <div className="flex items-center justify-end gap-1.5 pt-0.5">
      <button
        className={cn(
          "flex items-center gap-1 rounded-xs border border-emerald-500/15 bg-emerald-500/10 px-2.5 py-1.5",
          "font-medium text-[0.7rem] text-emerald-400",
          "transition-all duration-150 hover:border-emerald-500/30 hover:bg-emerald-500/20",
          "active:scale-[0.97]"
        )}
        disabled={!!actionState?.pending || !!actionState?.awaitingEvent}
        onClick={onApprove}
        title={isManualReview ? "Finalize & Implement" : "Approve"}
        type="button"
      >
        {actionState?.pending === "approve" ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : (
          <CheckIcon className="size-3.5" />
        )}
      </button>
      <button
        className={cn(
          "flex items-center gap-1 rounded-xs border border-rose-500/15 bg-rose-500/10 px-2.5 py-1.5",
          "font-medium text-[0.7rem] text-rose-400",
          "transition-all duration-150 hover:border-rose-500/30 hover:bg-rose-500/20",
          "active:scale-[0.97]"
        )}
        disabled={!!actionState?.pending || !!actionState?.awaitingEvent}
        onClick={onReject}
        title="Reject"
        type="button"
      >
        {actionState?.pending === "reject" ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : (
          <XIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
}
