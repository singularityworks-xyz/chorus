"use client";

import { DiffFloatingWindow } from "@chorus/monaco";
import type { Node, NodeProps } from "@xyflow/react";
import {
  ChevronDownIcon,
  Code2Icon,
  GitBranchIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
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
import { DiffNotice } from "@/features/kanban/components/diff-notice";
import { GitStatusFeedback } from "@/features/kanban/components/git-status-feedback";
import {
  KanbanCardContent,
  type KanbanCardData,
} from "@/features/kanban/components/kanban";
import { useKanbanCardActions } from "@/features/kanban/hooks/use-kanban-card-actions";
import { useWorkspace } from "@/features/workspace/workspace-context";
import {
  fetchGitStatus,
  fetchSessionDiff,
  type GitStatus,
  type SessionFileDiff,
} from "@/lib/opencode-client";
import { cn } from "@/lib/utils";

export const KANBAN_CARD_NODE_TYPE = "kanbanCard";

export interface KanbanCardNodeData {
  boardId: string;
  columns: KanbanCardData["columns"];
  filePath?: string;
  gitBranch?: string;
  gitStatus?: GitStatus | null;
  hasMobilePrompt?: boolean;
  isRemoving?: boolean;
  onRemove: (id: string) => void;
  onUpdateColumns: (id: string, columns: KanbanCardData["columns"]) => void;
  projectName?: string;
  reviewMode?: "manual" | "auto";
  sessionId?: string;
  sessionState: "uninitialized" | "starting" | "active" | "error";
  title: string;
  [key: string]: unknown;
}

const kanbanHeaderControlClass =
  "flex h-6 items-center rounded-xs font-medium text-[0.65rem] leading-none";

function hasBlockingSessionWork(columns: KanbanCardData["columns"]): boolean {
  return (
    Boolean(columns.in_progress?.length) ||
    (columns.approve ?? []).some(
      (task) =>
        task.outcome === "awaiting_review" && task.reviewApproved !== true
    )
  );
}

function focusBoardPrompt(
  boardId: string,
  focusBoardLocally: (boardId: string) => void
) {
  focusBoardLocally(boardId);
  window.requestAnimationFrame(() => {
    document.getElementById("chorus-prompt-input")?.focus();
  });
}

function FilePath({ path }: { path: string }) {
  const parts = path.split("/");
  const filename = parts.pop();
  const dir = parts.join("/");
  return (
    <span className="flex items-center gap-0.5 font-mono text-[0.7rem] leading-none">
      {dir && (
        <span className="text-white/30">
          {dir}
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

interface GitDiffIndicatorProps {
  status: GitStatus;
}

function GitDiffIndicator({ status }: GitDiffIndicatorProps) {
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
          kanbanHeaderControlClass,
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
          kanbanHeaderControlClass,
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
          kanbanHeaderControlClass,
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
        kanbanHeaderControlClass,
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

function inferLanguage(path?: string): string {
  if (!path) {
    return "plaintext";
  }
  const ext = path.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    java: "java",
    css: "css",
    scss: "scss",
    html: "html",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sh: "shell",
    bash: "shell",
    toml: "toml",
    xml: "xml",
    sql: "sql",
  };
  return ext ? (langMap[ext] ?? "plaintext") : "plaintext";
}

function useBoardDiffs(sessionId?: string) {
  const [diffVisible, setDiffVisible] = useState(false);
  const [diffFiles, setDiffFiles] = useState<SessionFileDiff[]>([]);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffNotice, setDiffNotice] = useState<string | null>(null);
  const [selectedDiffFile, setSelectedDiffFile] =
    useState<SessionFileDiff | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);

  const handleViewDiffs = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    setIsLoadingDiff(true);
    setDiffError(null);
    setDiffNotice(null);
    try {
      const diffs = await fetchSessionDiff(sessionId);
      setDiffFiles(diffs);
      if (diffs.length > 0) {
        setSelectedDiffFile(diffs[0]);
        setDiffVisible(true);
      } else {
        setDiffNotice("No file changes are available for this session.");
      }
    } catch (error) {
      setDiffError(
        error instanceof Error
          ? error.message
          : "Could not load session diffs. Try again."
      );
    } finally {
      setIsLoadingDiff(false);
    }
  }, [sessionId]);

  const handleSelectDiffFile = useCallback((diff: SessionFileDiff) => {
    setSelectedDiffFile(diff);
    setDiffVisible(true);
  }, []);

  const handleCloseDiff = useCallback(() => {
    setDiffVisible(false);
  }, []);

  return {
    diffError,
    diffFiles,
    diffNotice,
    diffVisible,
    handleCloseDiff,
    handleSelectDiffFile,
    handleViewDiffs,
    isLoadingDiff,
    selectedDiffFile,
  };
}

function KanbanCardNodeComponent({
  data: rawData,
  draggable,
  id,
  selected,
}: NodeProps<Node<Record<string, unknown>>>) {
  const cardData = rawData as unknown as KanbanCardNodeData;
  const configuredReviewMode = cardData.reviewMode ?? "auto";
  const [localGitStatus, setLocalGitStatus] = useState<GitStatus | null>(
    cardData.gitStatus ?? null
  );
  const [gitStatusError, setGitStatusError] = useState<string | null>(null);
  const [isLoadingGitStatus, setIsLoadingGitStatus] = useState(false);
  const gitStatusControllerRef = useRef<AbortController | null>(null);
  const {
    diffError,
    diffFiles,
    diffNotice,
    diffVisible,
    handleCloseDiff,
    handleSelectDiffFile,
    handleViewDiffs,
    isLoadingDiff,
    selectedDiffFile,
  } = useBoardDiffs(cardData.sessionId);

  const { focusBoardLocally } = useWorkspace();

  // Approve, reject, column moves and review mode live in one hook so the phone
  // lane list runs the same code as this card rather than a copy of it.
  const {
    actionStates,
    handleApprove,
    handleColumnsChange,
    handlePlanChange,
    handleQuestionsAnswered,
    handleReject,
    handleRetry,
    handleRun,
    handleReviewModeChange,
    reviewMode,
    reviewModeError,
    reviewModePending,
  } = useKanbanCardActions({
    boardId: cardData.boardId,
    columns: cardData.columns,
    onUpdateColumns: cardData.onUpdateColumns,
    reviewMode: configuredReviewMode,
    sessionId: cardData.sessionId,
  });
  const handleCreateTask = useCallback(() => {
    focusBoardPrompt(cardData.boardId, focusBoardLocally);
  }, [cardData.boardId, focusBoardLocally]);

  const filePath = cardData.filePath ?? cardData.projectName ?? cardData.title;

  const refreshGitStatus = useCallback(() => {
    gitStatusControllerRef.current?.abort();
    const controller = new AbortController();
    gitStatusControllerRef.current = controller;
    setGitStatusError(null);
    setIsLoadingGitStatus(true);
    fetchGitStatus(filePath, { signal: controller.signal })
      .then((status) => {
        if (!controller.signal.aborted) {
          setLocalGitStatus(status);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setGitStatusError(
            error instanceof Error
              ? error.message
              : "Could not load repository status. Retry."
          );
        }
      })
      .finally(() => {
        if (gitStatusControllerRef.current === controller) {
          gitStatusControllerRef.current = null;
          setIsLoadingGitStatus(false);
        }
      });
  }, [filePath]);

  useEffect(() => {
    refreshGitStatus();
    return () => {
      const controller = gitStatusControllerRef.current;
      if (controller) {
        controller.abort();
        gitStatusControllerRef.current = null;
      }
    };
  }, [refreshGitStatus]);

  return (
    <>
      <div
        className={cn(
          "dark flex h-full w-full flex-col overflow-hidden rounded-sm border border-white/10 bg-[#111111]/95 shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl transition-[box-shadow,border-color,background-color] duration-500",
          selected
            ? "border-white/16 shadow-[0_32px_100px_rgba(0,0,0,0.74)]"
            : "active:shadow-[0_32px_100px_rgba(0,0,0,0.8)] active:ring-1 active:ring-white/15"
        )}
      >
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

          {/* A stable hook for the board's presence in the DOM. Several nodes
              render this title (canvas card, lane-list chip, recents), and React
              Flow mounts and lays out asynchronously, so asserting on visible
              text is a layout race rather than a statement about state. */}
          <h2
            className="shrink-0 font-semibold text-[0.82rem] text-white/90 tracking-wide"
            data-board-title={cardData.title}
          >
            {cardData.title}
          </h2>

          <span className="h-3.5 w-px shrink-0 bg-white/10" />

          <div className="min-w-0 flex-1 truncate">
            <FilePath path={filePath} />
          </div>

          <div className="nodrag flex shrink-0 items-center gap-2.5">
            {cardData.gitBranch ? (
              <GitBranch branch={cardData.gitBranch} />
            ) : null}

            {localGitStatus && <GitDiffIndicator status={localGitStatus} />}

            <GitStatusFeedback
              error={gitStatusError}
              loading={isLoadingGitStatus}
              onRetry={refreshGitStatus}
            />

            <span className="h-3.5 w-px bg-white/10" />

            <SessionStatus
              sessionId={cardData.sessionId}
              state={cardData.sessionState}
            />

            {cardData.hasMobilePrompt && (
              <span
                className={cn(
                  kanbanHeaderControlClass,
                  "gap-1 border border-cyan-400/20 bg-cyan-400/10 px-2"
                )}
                title="Mobile prompt waiting"
              >
                <span className="text-cyan-300/80">📱</span>
              </span>
            )}

            <span className="h-3.5 w-px bg-white/10" />

            <BoardSessionHistoryControls
              boardBusy={hasBlockingSessionWork(cardData.columns)}
              boardId={cardData.boardId}
              sessionId={cardData.sessionId}
            />

            <span className="h-3.5 w-px bg-white/10" />

            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  kanbanHeaderControlClass,
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
                  disabled={!cardData.sessionId || isLoadingDiff}
                  onClick={handleViewDiffs}
                >
                  <Code2Icon className="size-3.5" />
                  <span>{isLoadingDiff ? "Loading..." : "View Diffs"}</span>
                </DropdownMenuItem>
                {diffFiles.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-white/80 text-xs transition-colors focus:bg-white/10 focus:text-white">
                      <span className="font-medium text-[0.65rem]">
                        Diff Files
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className="border-white/10 bg-[#1e1e1e] p-1.5"
                      style={{ maxHeight: "300px", overflowY: "auto" }}
                    >
                      {diffFiles.map((diff) => (
                        <DropdownMenuItem
                          className="flex cursor-pointer flex-col items-start gap-0.5 rounded-xs px-2 py-1.5 text-white/80 text-xs transition-colors focus:bg-white/10 focus:text-white"
                          key={diff.file}
                          onClick={() => handleSelectDiffFile(diff)}
                        >
                          <span className="max-w-[200px] truncate font-mono">
                            {diff.file}
                          </span>
                          <span className="flex gap-2 text-[0.6rem]">
                            <span className="text-emerald-400">
                              +{diff.additions}
                            </span>
                            <span className="text-red-400">
                              -{diff.deletions}
                            </span>
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
              aria-label={`Remove ${cardData.title} board`}
              className="rounded-xs p-1 text-white/25 transition-colors hover:bg-white/8 hover:text-white/60 disabled:cursor-wait disabled:opacity-40"
              disabled={cardData.isRemoving}
              onClick={() => cardData.onRemove(id)}
              title={cardData.isRemoving ? "Removing board…" : "Remove board"}
              type="button"
            >
              {cardData.isRemoving ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : (
                <XIcon className="size-3.5" />
              )}
            </button>
          </div>
        </div>

        <DiffNotice
          error={diffError}
          notice={diffNotice}
          onRetry={handleViewDiffs}
          retrying={isLoadingDiff}
        />

        <div className="nodrag flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 min-w-0 flex-1 p-4">
            <KanbanCardContent
              actionStates={actionStates}
              data={{
                id: cardData.boardId,
                title: cardData.title,
                columns: cardData.columns,
                reviewMode,
              }}
              onApprove={handleApprove}
              onColumnsChange={handleColumnsChange}
              onCreateTask={handleCreateTask}
              onPlanChange={handlePlanChange}
              onQuestionsAnswered={handleQuestionsAnswered}
              onReject={handleReject}
              onRetry={handleRetry}
              onReviewModeChange={handleReviewModeChange}
              onRun={handleRun}
              reviewModeError={reviewModeError}
              reviewModePending={reviewModePending}
            />
          </div>
        </div>
      </div>

      <DiffFloatingWindow
        language={
          selectedDiffFile
            ? inferLanguage(selectedDiffFile.file)
            : inferLanguage(filePath)
        }
        modified={selectedDiffFile?.after ?? ""}
        onClose={handleCloseDiff}
        original={selectedDiffFile?.before ?? ""}
        visible={diffVisible}
      />
    </>
  );
}

export const KanbanCardNode = memo(KanbanCardNodeComponent);
