"use client";

import { BorderlessFileView, DiffFloatingWindow } from "@chorus/monaco";
import type { Node, NodeProps } from "@xyflow/react";
import {
  ChevronDownIcon,
  Code2Icon,
  GitBranchIcon,
  GlobeIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  MonitorIcon,
  Redo2Icon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import posthog from "posthog-js";
import { memo, useCallback, useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type Columns,
  KanbanCardContent,
  type KanbanCardData,
  type Task,
} from "@/features/kanban/components/kanban";
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
  onRemove?: (id: string) => void;
  onUpdateColumns?: (id: string, columns: KanbanCardData["columns"]) => void;
  projectName?: string;
  reviewMode?: "manual" | "auto";
  sessionId?: string;
  sessionState: "uninitialized" | "starting" | "active" | "error";
  title: string;
  [key: string]: unknown;
}

const kanbanHeaderControlClass =
  "flex h-6 items-center rounded-xs font-medium text-[0.65rem] leading-none";

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

function KanbanCardNodeComponent({
  data: rawData,
  draggable,
  id,
  selected,
}: NodeProps<Node<Record<string, unknown>>>) {
  const cardData = rawData as unknown as KanbanCardNodeData;
  const [editorMode, setEditorMode] = useState<"kanban" | "file" | null>(null);
  const [diffVisible, setDiffVisible] = useState(false);
  const [diffFiles, setDiffFiles] = useState<SessionFileDiff[]>([]);
  const [selectedDiffFile, setSelectedDiffFile] =
    useState<SessionFileDiff | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [localColumns, setLocalColumns] = useState<Columns>(cardData.columns);
  const [localGitStatus, setLocalGitStatus] = useState<GitStatus | null>(
    cardData.gitStatus ?? null
  );

  const { kanbanHistory, restorePrompt, updateBoardReviewMode } =
    useWorkspace();

  useEffect(() => {
    setLocalColumns(cardData.columns);
  }, [cardData.columns]);

  const filePath = cardData.filePath ?? cardData.projectName ?? cardData.title;

  useEffect(() => {
    if (!filePath) {
      return;
    }

    let cancelled = false;

    fetchGitStatus(filePath)
      .then((status) => {
        if (!cancelled && status) {
          setLocalGitStatus(status);
        }
      })
      .catch(() => {
        // Silently fail - git status is not critical
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleColumnsChange = useCallback(
    (columns: Columns) => {
      const prevColumns = localColumns;
      setLocalColumns(columns);

      const doneTasks = columns.done ?? [];
      const prevDoneTasks = prevColumns.done ?? [];

      if (doneTasks.length > prevDoneTasks.length) {
        const newDoneTask = doneTasks.at(-1);
        if (newDoneTask) {
          kanbanHistory.recordMove(prevColumns, columns, newDoneTask);
        }
      }

      cardData.onUpdateColumns?.(id, columns);
    },
    [cardData, id, kanbanHistory, localColumns]
  );

  const handleUndo = useCallback(() => {
    const result = kanbanHistory.undo();
    if (!result) {
      return;
    }

    setLocalColumns(result.columns);
    cardData.onUpdateColumns?.(id, result.columns);
    restorePrompt(result.prompt);
  }, [kanbanHistory, cardData, id, restorePrompt]);

  const handleRedo = useCallback(() => {
    const result = kanbanHistory.redo();
    if (!result) {
      return;
    }

    setLocalColumns(result.columns);
    cardData.onUpdateColumns?.(id, result.columns);
  }, [kanbanHistory, cardData, id]);

  const handleOpenHere = useCallback(() => {
    setEditorMode("file");
  }, []);

  const handleOpenLocally = useCallback(() => {
    setEditorMode("kanban");
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditorMode(null);
  }, []);

  const handleViewDiffs = useCallback(async () => {
    if (!cardData.sessionId) {
      return;
    }
    setIsLoadingDiff(true);
    try {
      const diffs = await fetchSessionDiff(cardData.sessionId);
      setDiffFiles(diffs);
      if (diffs.length > 0) {
        setSelectedDiffFile(diffs[0]);
        setDiffVisible(true);
      }
    } catch (error) {
      console.error("Failed to fetch diffs:", error);
    } finally {
      setIsLoadingDiff(false);
    }
  }, [cardData.sessionId]);

  const handleSelectDiffFile = useCallback((diff: SessionFileDiff) => {
    setSelectedDiffFile(diff);
    setDiffVisible(true);
  }, []);

  const handleCloseDiff = useCallback(() => {
    setDiffVisible(false);
  }, []);

  const findTaskInApprove = useCallback(
    (taskId: string) => {
      const approveTasks = localColumns.approve ?? [];
      return approveTasks.find((t: Task) => t.id === taskId);
    },
    [localColumns]
  );

  const handleApprove = useCallback(
    async (taskId: string, plan: string, answers: string[]) => {
      const task = findTaskInApprove(taskId);
      if (!cardData.sessionId) {
        posthog.capture("kanban_review_approve_error", {
          reason: "no_session",
          boardId: cardData.boardId,
        });
        return;
      }

      posthog.capture("kanban_review_approve_start", {
        boardId: cardData.boardId,
        sessionId: cardData.sessionId,
        taskId,
        hasPlan: !!plan,
        hasAnswers: answers.some((a) => a.length > 0),
      });

      // Move task from approve → in_progress immediately
      if (!task) {
        return;
      }
      const updatedTask: Task = {
        ...task,
        plan: plan || task.plan || task.title,
      };
      const nextColumns = {
        ...localColumns,
        approve: (localColumns.approve ?? []).filter(
          (t: Task) => t.id !== taskId
        ),
        in_progress: [...(localColumns.in_progress ?? []), updatedTask],
      };
      setLocalColumns(nextColumns);
      cardData.onUpdateColumns?.(id, nextColumns);

      try {
        const planText = plan || task?.plan || task?.title || "";
        const questionPairs =
          task?.questions?.map((q: string, i: number) => ({
            question: q,
            answer: answers[i] ?? "",
          })) ?? [];

        const response = await fetch(
          `/api/tasks/${cardData.sessionId}/finalize-review`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              plan: planText,
              questions: questionPairs.length > 0 ? questionPairs : undefined,
            }),
          }
        );

        if (!response.ok) {
          posthog.capture("kanban_review_finalize_failed", {
            boardId: cardData.boardId,
            sessionId: cardData.sessionId,
            taskId,
            status: response.status,
          });
          return;
        }

        posthog.capture("kanban_review_finalize_success", {
          boardId: cardData.boardId,
          sessionId: cardData.sessionId,
          taskId,
        });
      } catch (error) {
        posthog.capture("kanban_review_finalize_error", {
          boardId: cardData.boardId,
          sessionId: cardData.sessionId,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      cardData.boardId,
      cardData.sessionId,
      cardData.onUpdateColumns,
      findTaskInApprove,
      id,
      localColumns,
    ]
  );

  const handleReject = useCallback(
    async (taskId: string) => {
      if (!cardData.sessionId) {
        posthog.capture("kanban_review_reject_error", {
          reason: "no_session",
          boardId: cardData.boardId,
        });
        return;
      }

      posthog.capture("kanban_review_reject_start", {
        boardId: cardData.boardId,
        sessionId: cardData.sessionId,
        taskId,
      });

      // Delete task from approve column
      const nextColumns = {
        ...localColumns,
        approve: (localColumns.approve ?? []).filter(
          (t: Task) => t.id !== taskId
        ),
      };
      setLocalColumns(nextColumns);
      cardData.onUpdateColumns?.(id, nextColumns);

      try {
        const response = await fetch(`/api/tasks/${cardData.sessionId}/abort`, {
          method: "POST",
        });

        if (!response.ok) {
          posthog.capture("kanban_review_abort_failed", {
            boardId: cardData.boardId,
            sessionId: cardData.sessionId,
            taskId,
            status: response.status,
          });
          return;
        }

        posthog.capture("kanban_review_abort_success", {
          boardId: cardData.boardId,
          sessionId: cardData.sessionId,
          taskId,
        });
      } catch (error) {
        posthog.capture("kanban_review_abort_error", {
          boardId: cardData.boardId,
          sessionId: cardData.sessionId,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      cardData.boardId,
      cardData.sessionId,
      cardData.onUpdateColumns,
      id,
      localColumns,
    ]
  );

  const handlePlanChange = useCallback(
    (_taskId: string, plan: string) => {
      posthog.capture("kanban_review_plan_updated", {
        boardId: cardData.boardId,
        planLength: plan.length,
      });
    },
    [cardData.boardId]
  );

  const handleQuestionsAnswered = useCallback(
    (_taskId: string, answers: string[]) => {
      posthog.capture("kanban_review_questions_answered", {
        boardId: cardData.boardId,
        answerCount: answers.length,
      });
    },
    [cardData.boardId]
  );

  const handleReviewModeChange = useCallback(
    (mode: "manual" | "auto") => {
      posthog.capture("kanban_review_mode_changed", {
        boardId: cardData.boardId,
        mode,
      });
      updateBoardReviewMode(cardData.boardId, mode);
    },
    [cardData.boardId, updateBoardReviewMode]
  );

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

            <div className="flex items-center gap-1">
              <button
                className={cn(
                  "rounded-xs p-1 transition-colors",
                  kanbanHistory.canUndo
                    ? "text-white/50 hover:bg-white/10 hover:text-white/80"
                    : "cursor-not-allowed text-white/15"
                )}
                disabled={!kanbanHistory.canUndo}
                onClick={handleUndo}
                title="Undo last task"
                type="button"
              >
                <Undo2Icon className="size-3.5" />
              </button>
              <button
                className={cn(
                  "rounded-xs p-1 transition-colors",
                  kanbanHistory.canRedo
                    ? "text-white/50 hover:bg-white/10 hover:text-white/80"
                    : "cursor-not-allowed text-white/15"
                )}
                disabled={!kanbanHistory.canRedo}
                onClick={handleRedo}
                title="Redo undone task"
                type="button"
              >
                <Redo2Icon className="size-3.5" />
              </button>
            </div>

            <span className="h-3.5 w-px bg-white/10" />

            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  kanbanHeaderControlClass,
                  "gap-1.5 bg-white/15 px-2 text-white transition-all hover:bg-white/25 active:scale-95"
                )}
              >
                <Code2Icon className="size-3" />
                <span>Open in Editor</span>
                <ChevronDownIcon className="size-3 text-white/50" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-40 border-white/10 bg-[#1e1e1e] p-1.5 text-white/90 shadow-2xl"
              >
                <DropdownMenuItem
                  className="flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-white/80 text-xs transition-colors focus:bg-white/10 focus:text-white"
                  onClick={handleOpenLocally}
                >
                  <MonitorIcon className="size-3.5" />
                  <span>Open Locally</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-white/80 text-xs transition-colors focus:bg-white/10 focus:text-white"
                  onClick={handleOpenHere}
                >
                  <GlobeIcon className="size-3.5" />
                  <span>Open Here</span>
                </DropdownMenuItem>
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

            {editorMode !== null && (
              <button
                className="rounded-xs bg-white/10 px-2 py-1 font-medium text-[0.65rem] text-white transition-all hover:bg-white/20 active:scale-95"
                onClick={handleCloseEditor}
                type="button"
              >
                Back to Kanban
              </button>
            )}

            {cardData.onRemove && (
              <>
                <span className="h-3.5 w-px bg-white/10" />
                <button
                  className="rounded-xs p-1 text-white/25 transition-colors hover:bg-white/8 hover:text-white/60"
                  onClick={() => cardData.onRemove?.(id)}
                  type="button"
                >
                  <XIcon className="size-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="nodrag flex min-h-0 min-w-0 flex-1 flex-col">
          {editorMode === "file" && filePath ? (
            <BorderlessFileView
              filePath={filePath}
              language={inferLanguage(filePath)}
              value={`// File: ${filePath}\n// Connect to LSP to see live content`}
            />
          ) : (
            <div className="min-h-0 min-w-0 flex-1 p-4">
              <KanbanCardContent
                data={{
                  id: cardData.boardId,
                  title: cardData.title,
                  columns: cardData.columns,
                  reviewMode: cardData.reviewMode ?? "auto",
                }}
                onApprove={handleApprove}
                onColumnsChange={handleColumnsChange}
                onPlanChange={handlePlanChange}
                onQuestionsAnswered={handleQuestionsAnswered}
                onReject={handleReject}
                onReviewModeChange={handleReviewModeChange}
              />
            </div>
          )}
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
