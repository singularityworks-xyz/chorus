"use client";

import {
  ChevronDownIcon,
  Code2Icon,
  GitBranchIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BoardSessionHistoryControls } from "@/features/kanban/components/board-session-history-controls";
import { GitStatusFeedback } from "@/features/kanban/components/git-status-feedback";
import type { GitStatus, SessionFileDiff } from "@/lib/opencode-client";
import { cn } from "@/lib/utils";
import type { KanbanCardNodeData } from "./node-data";

const controlClass =
  "flex h-6 items-center rounded-xs font-medium text-[0.65rem] leading-none";

function FilePath({ path }: { path: string }) {
  const parts = path.split("/");
  const filename = parts.pop();
  const directory = parts.join("/");
  return (
    <span className="flex items-center gap-0.5 font-mono text-[0.7rem] leading-none">
      {directory && (
        <span className="text-white/30">
          {directory}
          <span className="mx-0.5 text-white/20">/</span>
        </span>
      )}
      <span className="text-white/60">{filename}</span>
    </span>
  );
}

function GitBranch({ branch }: { branch: string }) {
  return (
    <span className="flex items-center gap-1 rounded-xs border border-white/8 bg-white/5 px-1.5 py-0.5">
      <GitBranchIcon className="size-2.5 text-white/40" />
      <span className="font-mono text-[0.65rem] text-white/50 leading-none">
        {branch}
      </span>
    </span>
  );
}

function GitDiffIndicator({ status }: { status: GitStatus }) {
  const hasChanges =
    status.untracked > 0 ||
    status.modified > 0 ||
    status.staged > 0 ||
    status.linesAdded > 0 ||
    status.linesRemoved > 0;
  if (!hasChanges) {
    return null;
  }

  return (
    <span className="flex items-center gap-1.5 rounded-xs border border-white/8 bg-white/5 px-1.5 py-0.5">
      {status.untracked > 0 && (
        <span
          className="font-mono text-[0.6rem] text-amber-400/80 leading-none"
          title={`${status.untracked} untracked files`}
        >
          ?{status.untracked}
        </span>
      )}
      {status.modified > 0 && (
        <span
          className="font-mono text-[0.6rem] text-orange-400/80 leading-none"
          title={`${status.modified} modified files`}
        >
          ~{status.modified}
        </span>
      )}
      {status.staged > 0 && (
        <span
          className="font-mono text-[0.6rem] text-emerald-400/80 leading-none"
          title={`${status.staged} staged files`}
        >
          +{status.staged}
        </span>
      )}
      {status.linesAdded > 0 && (
        <span className="font-mono text-[0.6rem] text-emerald-400/80 leading-none">
          +{status.linesAdded}
        </span>
      )}
      {status.linesRemoved > 0 && (
        <span className="font-mono text-[0.6rem] text-red-400/80 leading-none">
          -{status.linesRemoved}
        </span>
      )}
      {status.ahead > 0 && (
        <span
          className="font-mono text-[0.6rem] text-cyan-400/80 leading-none"
          title={`${status.ahead} commits ahead`}
        >
          ↑{status.ahead}
        </span>
      )}
      {status.behind > 0 && (
        <span
          className="font-mono text-[0.6rem] text-purple-400/80 leading-none"
          title={`${status.behind} commits behind`}
        >
          ↓{status.behind}
        </span>
      )}
    </span>
  );
}

function SessionStatus({
  sessionId,
  state,
}: {
  sessionId?: string;
  state: KanbanCardNodeData["sessionState"];
}) {
  if (state === "starting") {
    return (
      <span
        className={cn(
          controlClass,
          "gap-1 border border-cyan-400/20 bg-cyan-400/10 px-2"
        )}
      >
        <LoaderCircleIcon className="size-3 animate-spin text-cyan-300/80" />
        <span className="font-medium text-[0.65rem] text-cyan-200/80 leading-none">
          Starting
        </span>
      </span>
    );
  }
  if (state === "error") {
    return (
      <span
        className={cn(
          controlClass,
          "gap-1 border border-red-400/20 bg-red-400/10 px-2"
        )}
      >
        <TriangleAlertIcon className="size-3 text-red-300/80" />
        <span className="font-medium text-[0.65rem] text-red-200/80 leading-none">
          Error
        </span>
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        className={cn(
          controlClass,
          "gap-1 border border-emerald-400/20 bg-emerald-400/10 px-2"
        )}
      >
        <span className="size-1.5 rounded-full bg-emerald-300/90" />
        <span className="font-medium text-[0.65rem] text-emerald-200/80 leading-none">
          {sessionId ? "Live" : "Ready"}
        </span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        controlClass,
        "gap-1 border border-white/8 bg-white/5 px-2"
      )}
    >
      <span className="size-1.5 rounded-full bg-white/35" />
      <span className="font-medium text-[0.65rem] text-white/55 leading-none">
        Ready
      </span>
    </span>
  );
}

export function KanbanCardNodeHeader({
  boardBusy,
  data,
  diffFiles,
  draggable,
  gitStatus,
  gitStatusError,
  isLoadingDiff,
  isLoadingGitStatus,
  onRemove,
  onRetryGitStatus,
  onSelectDiffFile,
  onViewDiffs,
}: {
  boardBusy: boolean;
  data: KanbanCardNodeData;
  diffFiles: SessionFileDiff[];
  draggable: boolean;
  gitStatus: GitStatus | null;
  gitStatusError: string | null;
  isLoadingDiff: boolean;
  isLoadingGitStatus: boolean;
  onRemove: () => void;
  onRetryGitStatus: () => void;
  onSelectDiffFile: (diff: SessionFileDiff) => void;
  onViewDiffs: () => void;
}) {
  const filePath = data.filePath ?? data.projectName ?? data.title;
  return (
    <div className="flex items-center gap-3 border-white/8 border-b px-3 py-2.5">
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-xs p-1 transition-colors",
          draggable
            ? "cursor-grab text-white/25 hover:text-white/50 active:cursor-grabbing"
            : "cursor-default text-white/18"
        )}
      >
        <GripVerticalIcon className="size-3.5" />
      </div>

      <h2
        className="shrink-0 font-semibold text-[0.82rem] text-white/90 tracking-wide"
        data-board-title={data.title}
      >
        {data.title}
      </h2>

      <span className="h-3.5 w-px shrink-0 bg-white/10" />
      <div className="min-w-0 flex-1 truncate">
        <FilePath path={filePath} />
      </div>

      <div className="nodrag flex shrink-0 items-center gap-2.5">
        {data.gitBranch && <GitBranch branch={data.gitBranch} />}
        {gitStatus && <GitDiffIndicator status={gitStatus} />}
        <GitStatusFeedback
          error={gitStatusError}
          loading={isLoadingGitStatus}
          onRetry={onRetryGitStatus}
        />

        <span className="h-3.5 w-px bg-white/10" />
        <SessionStatus sessionId={data.sessionId} state={data.sessionState} />
        {data.hasMobilePrompt && (
          <span
            className={cn(
              controlClass,
              "gap-1 border border-cyan-400/20 bg-cyan-400/10 px-2"
            )}
            title="Mobile prompt waiting"
          >
            <span className="text-cyan-300/80">📱</span>
          </span>
        )}

        <span className="h-3.5 w-px bg-white/10" />
        <BoardSessionHistoryControls
          boardBusy={boardBusy}
          boardId={data.boardId}
          sessionId={data.sessionId}
        />
        <span className="h-3.5 w-px bg-white/10" />

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              controlClass,
              "gap-1.5 bg-white/15 px-2 text-white transition-all hover:bg-white/25 active:scale-95"
            )}
          >
            <Code2Icon className="size-3" />
            <span>Review Changes</span>
            <ChevronDownIcon className="size-3 text-white/50" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40 border-white/10 bg-[#1e1e1e] p-1.5 text-white/90 shadow-2xl"
          >
            <DropdownMenuItem
              className="flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-white/80 text-xs transition-colors focus:bg-white/10 focus:text-white"
              disabled={!data.sessionId || isLoadingDiff}
              onClick={onViewDiffs}
            >
              <Code2Icon className="size-3.5" />
              <span>{isLoadingDiff ? "Loading..." : "View Diffs"}</span>
            </DropdownMenuItem>
            {diffFiles.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-white/80 text-xs transition-colors focus:bg-white/10 focus:text-white">
                  <span className="font-medium text-[0.65rem]">Diff Files</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  className="border-white/10 bg-[#1e1e1e] p-1.5"
                  style={{ maxHeight: "300px", overflowY: "auto" }}
                >
                  {diffFiles.map((diff) => (
                    <DropdownMenuItem
                      className="flex cursor-pointer flex-col items-start gap-0.5 rounded-xs px-2 py-1.5 text-white/80 text-xs transition-colors focus:bg-white/10 focus:text-white"
                      key={diff.file}
                      onClick={() => onSelectDiffFile(diff)}
                    >
                      <span className="max-w-[200px] truncate font-mono">
                        {diff.file}
                      </span>
                      <span className="flex gap-2 text-[0.6rem]">
                        <span className="text-emerald-400">
                          +{diff.additions}
                        </span>
                        <span className="text-red-400">-{diff.deletions}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="h-3.5 w-px bg-white/10" />
        <button
          aria-label={`Remove ${data.title} board`}
          className="rounded-xs p-1 text-white/25 transition-colors hover:bg-white/8 hover:text-white/60 disabled:cursor-wait disabled:opacity-40"
          disabled={data.isRemoving}
          onClick={onRemove}
          title={data.isRemoving ? "Removing board…" : "Remove board"}
          type="button"
        >
          {data.isRemoving ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <XIcon className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
