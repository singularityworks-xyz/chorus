"use client";

import type { Task } from "@chorus/contracts";
import { BorderlessFileView, ChorusMonaco } from "@chorus/monaco";
import {
  BrainIcon,
  CheckIcon,
  CogIcon,
  LoaderIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AgentOutputCard,
  type AgentStep,
} from "@/features/kanban/components/agent-output-card";
import type { KanbanTaskActionState } from "@/features/kanban/hooks/use-kanban-card-actions";
import { cn } from "@/lib/utils";
import type { ChangedFile } from "../types";
import { getBoardTaskCommandButtonState } from "../utils/board-task-state";
import { type GroupedStep, groupSteps } from "../utils/group-steps";
import {
  getPendingQuestionApprovals,
  hasPendingQuestion,
  shouldShowReviewActions,
} from "../utils/task-approval-state";
import { KanbanItem, KanbanItemHandle } from "./kanban";
import { QuestionCard } from "./question-card";

function extractChangedFiles(steps: AgentStep[]): ChangedFile[] {
  const fileMap = new Map<string, { added: number; removed: number }>();
  for (const step of steps) {
    if (step.kind === "file_edit" && step.filePath) {
      const existing = fileMap.get(step.filePath) ?? { added: 0, removed: 0 };
      fileMap.set(step.filePath, {
        added: existing.added + (step.linesAdded ?? 0),
        removed: existing.removed + (step.linesRemoved ?? 0),
      });
    }
  }
  return [...fileMap.entries()].map(([path, stats]) => ({
    path,
    ...stats,
  }));
}

export function computeDiffTotals(steps: AgentStep[]): {
  added: number;
  fileCount: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  let fileCount = 0;
  const seenFiles = new Set<string>();
  for (const step of steps) {
    added += step.linesAdded ?? 0;
    removed += step.linesRemoved ?? 0;
    if (
      step.kind === "file_edit" &&
      step.filePath &&
      !seenFiles.has(step.filePath)
    ) {
      seenFiles.add(step.filePath);
      fileCount++;
    }
  }
  return { added, removed, fileCount };
}

function FilePill({ path }: { path: string }) {
  const parts = path.replace(/\\/g, "/").split("/");
  const label = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-xs bg-white/4 px-1.5 py-0.5 font-mono text-[0.6rem] text-white/35 ring-1 ring-white/6 ring-inset transition-colors hover:bg-white/7 hover:text-white/55"
      title={path}
    >
      <span className="opacity-50">#</span>
      {label}
    </span>
  );
}

function ChangedFileRow({ file }: { file: ChangedFile }) {
  const parts = file.path.replace(/\\/g, "/").split("/");
  const label = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : file.path;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        className="flex-1 truncate font-mono text-[0.62rem] text-white/40"
        title={file.path}
      >
        {label}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {file.added > 0 && (
          <span className="inline-flex items-center rounded-xs bg-emerald-500/10 px-1 py-0 font-mono text-[0.58rem] text-emerald-400/75">
            +{file.added}
          </span>
        )}
        {file.removed > 0 && (
          <span className="inline-flex items-center rounded-xs bg-red-500/10 px-1 py-0 font-mono text-[0.58rem] text-red-400/65">
            -{file.removed}
          </span>
        )}
      </div>
    </div>
  );
}

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

function DoneStepRow({ step }: { step: AgentStep }) {
  const kindIcons: Record<AgentStep["kind"], React.ReactNode> = {
    thinking: <BrainIcon className="size-3 text-white/30" />,
    response: <MessageSquareIcon className="size-3 text-white/30" />,
    tool_call: <WrenchIcon className="size-3 text-white/30" />,
    file_edit: <CogIcon className="size-3 text-white/30" />,
    command: <TerminalIcon className="size-3 text-white/30" />,
  };

  return (
    <div className="flex items-start gap-1.5">
      <span className="mt-0.5 shrink-0">{kindIcons[step.kind] ?? "•"}</span>
      <span className="min-w-0 flex-1 font-mono text-[0.68rem] text-white/50 leading-relaxed">
        {step.summary}
      </span>
    </div>
  );
}

function DoneGroupedStepRow({ group }: { group: GroupedStep }) {
  switch (group.kind) {
    case "thinking":
    case "response":
      return (
        <div className="flex items-start gap-1.5">
          <span className="mt-0.5 shrink-0">
            {group.kind === "thinking" ? (
              <BrainIcon className="size-3 text-white/30" />
            ) : (
              <MessageSquareIcon className="size-3 text-white/30" />
            )}
          </span>
          <span className="min-w-0 flex-1 font-mono text-[0.68rem] text-white/50 leading-relaxed">
            {group.summary}
          </span>
          {group.sourceSteps.length > 1 && (
            <span className="rounded-xs bg-white/5 px-1 py-0.5 font-mono text-[0.55rem] text-white/25">
              ×{group.sourceSteps.length}
            </span>
          )}
        </div>
      );
    case "file_edit":
      return <DoneStepRow step={group.step} />;
    case "tool_call":
    case "command":
      return <DoneStepRow step={group.step} />;
    default:
      return null;
  }
}

function TaskCardDiffSection({
  changedFiles,
  diffTotals,
}: {
  changedFiles: ChangedFile[];
  diffTotals: { added: number; removed: number };
}) {
  if (changedFiles.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-white/5 border-t pt-2.5">
      {changedFiles.map((f) => (
        <ChangedFileRow file={f} key={f.path} />
      ))}
      <div className="flex items-center gap-1.5 pt-0.5">
        {diffTotals.added > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded-xs bg-emerald-500/15 px-1.5 py-0.5 font-medium font-mono text-[0.62rem] text-emerald-400">
            <PlusIcon className="size-2.5" />+{diffTotals.added}
          </span>
        )}
        {diffTotals.removed > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded-xs bg-red-500/15 px-1.5 py-0.5 font-medium font-mono text-[0.62rem] text-red-400">
            <XIcon className="size-2.5" />-{diffTotals.removed}
          </span>
        )}
        <span className="font-medium text-[0.62rem] text-white/30">
          {changedFiles.length} file{changedFiles.length === 1 ? "" : "s"}{" "}
          changed
        </span>
      </div>
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TaskCard renders multiple conditional sections for different task states (queue, in_progress, review, done)
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
  const changedFiles = task.run
    ? extractChangedFiles(task.run.steps)
    : (task.changedFiles ?? []);
  const diffTotals = task.run
    ? computeDiffTotals(task.run.steps)
    : { added: task.linesAdded ?? 0, removed: task.linesRemoved ?? 0 };
  const hasQuestion = hasPendingQuestion(task);
  const showReviewActions =
    showApprovalControls && shouldShowReviewActions(task);

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

  const isManualReview =
    showApprovalControls &&
    task.outcome === "awaiting_review" &&
    task.reviewApproved !== true;

  const handleApproveClick = () => {
    if (isManualReview) {
      if (editedPlan !== task.plan) {
        onPlanChange(task.id, editedPlan);
      }
      onApprove(task.id, editedPlan, questionAnswers);
    } else {
      onApprove(task.id, "", []);
    }
  };

  const handleQuestionChange = (qIndex: number, value: string) => {
    const newAnswers = [...questionAnswers];
    newAnswers[qIndex] = value;
    setQuestionAnswers(newAnswers);
    onQuestionsAnswered(task.id, newAnswers);
  };

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

      {isManualReview && (
        <div className="flex flex-col gap-3 border-white/5 border-t pt-2.5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[0.7rem] text-amber-400 uppercase tracking-wider">
                Plan
              </span>
              <button
                className="rounded-xs border border-white/8 bg-white/5 px-2 py-0.5 text-[0.65rem] text-white/60 transition-colors hover:border-amber-400/30 hover:bg-white/10 hover:text-amber-400"
                onClick={() => setShowPlanPopup(true)}
                type="button"
              >
                Expand
              </button>
            </div>
            <div className="min-h-[120px] w-full overflow-hidden rounded-xs border border-white/10">
              <BorderlessFileView
                className="h-full min-h-[120px]"
                filePath="plan.md"
                height="120px"
                language="markdown"
                onChange={(val) => setEditedPlan(val)}
                value={editedPlan}
              />
            </div>
          </div>
          {task.questions && task.questions.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="font-medium text-[0.7rem] text-amber-400 uppercase tracking-wider">
                Questions
              </span>
              {task.questions.map((question, qIndex) => (
                <div className="flex flex-col gap-1" key={question}>
                  <p className="text-[0.7rem] text-white/60 leading-relaxed">
                    {question}
                  </p>
                  <input
                    className="w-full rounded-xs border border-white/10 bg-white/5 px-2.5 py-1.5 font-mono text-[0.7rem] text-white/70 leading-relaxed placeholder:text-white/20 focus:border-amber-400/40 focus:outline-none"
                    onChange={(e) =>
                      handleQuestionChange(qIndex, e.target.value)
                    }
                    placeholder="Your answer..."
                    type="text"
                    value={questionAnswers[qIndex] ?? ""}
                  />
                </div>
              ))}
            </div>
          )}
          {!task.plan && (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <span className="text-[0.72rem] text-white/30">
                Waiting for AI to generate a plan...
              </span>
            </div>
          )}
          {task.errorMessage && (
            <p
              className="rounded-xs border border-rose-500/15 bg-rose-500/[0.03] px-2.5 py-2 text-[0.68rem] text-rose-300/85 leading-relaxed"
              role="status"
            >
              {task.errorMessage}
            </p>
          )}
        </div>
      )}

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
            {task.changedFiles.map((f) => (
              <ChangedFileRow file={f} key={f.path} />
            ))}
          </div>
        )}

      {showDone && (
        <div className="flex flex-col gap-2.5 border-white/5 border-t pt-2.5">
          {task.errorMessage && (
            <p
              className="rounded-xs border border-rose-500/15 bg-rose-500/[0.03] px-2.5 py-2 text-[0.68rem] text-rose-300/85 leading-relaxed"
              role="status"
            >
              {task.errorMessage}
            </p>
          )}
          {task.run && task.run.steps.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {groupSteps(task.run.steps).map((group) => (
                <DoneGroupedStepRow
                  group={group}
                  key={
                    group.kind === "thinking" || group.kind === "response"
                      ? group.id
                      : group.step.id
                  }
                />
              ))}
            </div>
          )}
          {!task.run && task.summary && (
            <p className="text-[0.72rem] text-white/38 leading-relaxed">
              {task.summary}
            </p>
          )}
          <TaskCardDiffSection
            changedFiles={changedFiles}
            diffTotals={diffTotals}
          />
        </div>
      )}

      {showPlay && task.taggedFiles && task.taggedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {task.taggedFiles.map((f) => (
            <FilePill key={f} path={f} />
          ))}
        </div>
      )}

      {showPlay && (
        <div className="flex items-center justify-end pt-0.5">
          <button
            className={cn(
              "flex items-center gap-1.5 rounded-xs border border-white/6 bg-white/6 px-2.5 py-1.5",
              "font-medium text-[0.7rem] text-white/50",
              "transition-all duration-150",
              "hover:border-emerald-500/20 hover:bg-emerald-500/12 hover:text-emerald-400",
              "active:scale-[0.97]"
            )}
            disabled={runButton.disabled}
            onClick={() => onRun(task.id)}
            title={runButton.title}
            type="button"
          >
            {actionState?.pending === "run" ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <PlayIcon className="size-3 fill-current" />
            )}
            {runButton.label}
          </button>
        </div>
      )}

      {showApprovalControls &&
        reviewMode === "auto" &&
        task.changedFiles &&
        task.changedFiles.length > 0 && (
          <div className="flex flex-col gap-1 border-white/5 border-t pt-2.5">
            {task.changedFiles.map((f) => (
              <ChangedFileRow file={f} key={f.path} />
            ))}
          </div>
        )}

      {showApprovalControls && hasQuestion && task.run?.sessionId && (
        <QuestionCard
          requests={getPendingQuestionApprovals(task)}
          sessionID={task.run.sessionId}
        />
      )}

      {showReviewActions && (
        <div className="flex items-center justify-end gap-1.5 pt-0.5">
          <button
            className={cn(
              "flex items-center gap-1 rounded-xs border border-emerald-500/15 bg-emerald-500/10 px-2.5 py-1.5",
              "font-medium text-[0.7rem] text-emerald-400",
              "transition-all duration-150 hover:border-emerald-500/30 hover:bg-emerald-500/20",
              "active:scale-[0.97]"
            )}
            disabled={!!actionState?.pending || !!actionState?.awaitingEvent}
            onClick={handleApproveClick}
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
            onClick={() => onReject(task.id)}
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
      )}

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
            disabled={retryButton.disabled}
            onClick={() => onRetry(task.id)}
            title={retryButton.title}
            type="button"
          >
            {actionState?.pending === "retry" ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <RotateCcwIcon className="size-3" />
            )}
            {retryButton.label}
          </button>
        </div>
      )}
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
      {showPlanPopup &&
        createPortal(
          <>
            <button
              aria-label="Close implementation plan"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
              onClick={() => setShowPlanPopup(false)}
              type="button"
            />
            <div
              aria-label="Implementation Plan"
              aria-modal="true"
              className="fixed inset-0 z-[51] m-auto flex h-[80vh] w-[80vw] min-w-[600px] flex-col rounded-lg border border-white/10 bg-[#0d0d0d] shadow-2xl max-md:h-full max-md:w-full max-md:min-w-0 max-md:rounded-none max-md:border-0"
              role="dialog"
              tabIndex={-1}
            >
              <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
                <span className="font-medium text-[0.8rem] text-amber-400 uppercase tracking-wider">
                  Implementation Plan
                </span>
                <button
                  aria-label="Close"
                  className="rounded-xs p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
                  onClick={() => setShowPlanPopup(false)}
                  type="button"
                >
                  <XIcon className="size-4" />
                </button>
              </div>
              <div className="flex-1 overflow-hidden p-3">
                <ChorusMonaco
                  filePath="plan.md"
                  height="100%"
                  language="markdown"
                  onChange={(val) => setEditedPlan(val ?? "")}
                  value={editedPlan}
                />
              </div>
            </div>
          </>,
          document.body
        )}
    </KanbanItem>
  );
}
