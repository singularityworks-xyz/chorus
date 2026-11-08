"use client";

import {
  acceptedCommandResponseSchema,
  apiErrorSchema,
} from "@chorus/contracts";
import { BorderlessFileView, InlineDiffView } from "@chorus/monaco";
import {
  BrainIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FilePenLineIcon,
  Loader2Icon,
  MessageSquareIcon,
  SquareIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { type GroupedStep, groupSteps } from "../utils/group-steps";

export type AgentStepKind =
  | "thinking"
  | "response"
  | "file_edit"
  | "tool_call"
  | "command";

export type AgentStepStatus = "running" | "done" | "error";

export interface AgentStep {
  content?: string;
  filePath?: string;
  id: string;
  kind: AgentStepKind;
  linesAdded?: number;
  linesRemoved?: number;
  modifiedContent?: string;
  originalContent?: string;
  status: AgentStepStatus;
  summary: string;
}

export interface AgentRunContext {
  elapsed: string;
  model: string;
  sessionId?: string;
  startedAt?: number;
  steps: AgentStep[];
  taskTitle: string;
}

const EMPTY_AGENT_STEPS: AgentStep[] = [];
const MARKDOWN_PLUGINS = [remarkGfm];
const MARKDOWN_REFRESH_INTERVAL_MS = 100;

function useStreamedMarkdownContent(content: string, isStreaming: boolean) {
  const [displayedContent, setDisplayedContent] = useState(content);
  const latestContent = useRef(content);
  latestContent.current = content;

  useEffect(() => {
    if (!isStreaming) {
      setDisplayedContent(latestContent.current);
      return;
    }

    setDisplayedContent(latestContent.current);
    const interval = window.setInterval(() => {
      setDisplayedContent(latestContent.current);
    }, MARKDOWN_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isStreaming]);

  return isStreaming ? displayedContent : content;
}

const MarkdownContent = memo(function MarkdownContent({
  className,
  content,
}: {
  className: string;
  content: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{content}</ReactMarkdown>
    </div>
  );
});

const STEP_META: Record<
  AgentStepKind,
  {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    color: string;
  }
> = {
  thinking: { icon: BrainIcon, label: "Thinking", color: "text-violet-400" },
  response: {
    icon: MessageSquareIcon,
    label: "Response",
    color: "text-sky-400",
  },
  file_edit: {
    icon: FilePenLineIcon,
    label: "Edit",
    color: "text-emerald-400",
  },
  tool_call: { icon: WrenchIcon, label: "Tool", color: "text-amber-400" },
  command: { icon: TerminalIcon, label: "Run", color: "text-white/50" },
};

function inferLanguage(filePath?: string): string {
  if (!filePath) {
    return "plaintext";
  }
  const ext = filePath.split(".").pop()?.toLowerCase();
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

function GroupedThinkingBlock({
  group,
}: {
  group: NonNullable<Extract<GroupedStep, { kind: "thinking" }>>;
}) {
  const isRunning = group.status === "running";
  const [expanded, setExpanded] = useState(false);
  const hasContent = group.content && group.content.length > 0;
  const stepCount = group.sourceSteps.length;
  const displayedContent = useStreamedMarkdownContent(
    group.content,
    isRunning && expanded
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-violet-400/60" />
        ) : (
          <CheckCircle2Icon className="size-3 shrink-0 text-white/20" />
        )}

        <BrainIcon className="size-3 shrink-0 text-violet-400" />
        <span className="font-medium text-[0.65rem] text-violet-400 uppercase tracking-wider">
          Thinking
        </span>

        {stepCount > 1 && (
          <span className="rounded-xs bg-violet-500/10 px-1.5 py-0.5 font-mono text-[0.6rem] text-violet-300/70">
            {stepCount}
          </span>
        )}

        <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] text-white/60">
          {group.summary}
        </span>

        {hasContent && (
          <button
            className="shrink-0 rounded-xs p-0.5 transition-colors hover:bg-white/10"
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            {expanded ? (
              <ChevronDownIcon className="size-3 text-white/30" />
            ) : (
              <ChevronRightIcon className="size-3 text-white/20" />
            )}
          </button>
        )}
      </div>

      {expanded && hasContent && (
        <div className="ml-5 rounded-xs border border-violet-500/10 bg-violet-500/[0.03] px-3 py-2.5">
          <MarkdownContent
            className="text-[0.72rem] text-violet-300/60 leading-relaxed"
            content={displayedContent}
          />
        </div>
      )}
    </div>
  );
}

function GroupedResponseBlock({
  group,
}: {
  group: {
    kind: "response";
    id: string;
    status: AgentStep["status"];
    summary: string;
    content: string;
    sourceSteps: AgentStep[];
  };
}) {
  const isRunning = group.status === "running";
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasContent = group.content && group.content.length > 0;
  const stepCount = group.sourceSteps.length;
  const displayedContent = useStreamedMarkdownContent(
    group.content,
    isRunning && expanded
  );

  function handleCopy() {
    if (group.content) {
      navigator.clipboard.writeText(group.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-sky-400/60" />
        ) : (
          <CheckCircle2Icon className="size-3 shrink-0 text-white/20" />
        )}

        <MessageSquareIcon className="size-3 shrink-0 text-sky-400" />
        <span className="font-medium text-[0.65rem] text-sky-400 uppercase tracking-wider">
          Response
        </span>

        {stepCount > 1 && (
          <span className="rounded-xs bg-sky-500/10 px-1.5 py-0.5 font-mono text-[0.6rem] text-sky-300/70">
            {stepCount}
          </span>
        )}

        <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] text-white/60">
          {group.summary}
        </span>

        {hasContent && (
          <>
            <button
              className="shrink-0 rounded-xs p-0.5 transition-colors hover:bg-white/10"
              onClick={handleCopy}
              type="button"
            >
              <CopyIcon
                className={cn(
                  "size-3",
                  copied ? "text-emerald-400" : "text-white/30"
                )}
              />
            </button>
            <button
              className="shrink-0 rounded-xs p-0.5 transition-colors hover:bg-white/10"
              onClick={() => setExpanded(!expanded)}
              type="button"
            >
              {expanded ? (
                <ChevronDownIcon className="size-3 text-white/30" />
              ) : (
                <ChevronRightIcon className="size-3 text-white/20" />
              )}
            </button>
          </>
        )}
      </div>

      {expanded && hasContent && (
        <div className="ml-5 rounded-xs border border-sky-500/10 bg-sky-500/[0.03] px-3 py-2.5">
          <MarkdownContent
            className="text-[0.72rem] text-sky-300/70 leading-relaxed"
            content={displayedContent}
          />
        </div>
      )}
    </div>
  );
}

function ChangesBlock({ step }: { step: AgentStep }) {
  const isRunning = step.status === "running";
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const hasOriginal = step.originalContent && step.originalContent.length > 0;
  const hasModified = step.modifiedContent && step.modifiedContent.length > 0;
  const hasActualChanges =
    (step.linesAdded ?? 0) > 0 || (step.linesRemoved ?? 0) > 0;
  const canShowDiff = hasOriginal && hasModified && hasActualChanges;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-emerald-400/60" />
        ) : (
          <CheckCircle2Icon className="size-3 shrink-0 text-white/20" />
        )}

        <FilePenLineIcon className="size-3 shrink-0 text-emerald-400" />
        <span className="font-medium text-[0.65rem] text-emerald-400 uppercase tracking-wider">
          Edit
        </span>

        <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] text-white/60">
          {step.summary}
        </span>

        <span className="flex shrink-0 items-center gap-1.5 text-[0.65rem]">
          {step.linesAdded !== undefined && step.linesAdded > 0 && (
            <span className="text-emerald-400/80">+{step.linesAdded}</span>
          )}
          {step.linesRemoved !== undefined && step.linesRemoved > 0 && (
            <span className="text-red-400/70">-{step.linesRemoved}</span>
          )}
        </span>

        {canShowDiff && (
          <button
            className={cn(
              "shrink-0 rounded-xs px-1.5 py-0.5 font-medium text-[0.6rem] transition-colors",
              showDiff
                ? "bg-emerald-500/15 text-emerald-400"
                : "text-white/30 hover:bg-white/10 hover:text-white/50"
            )}
            onClick={() => setShowDiff(!showDiff)}
            type="button"
          >
            {showDiff ? "Hide Diff" : "Diff"}
          </button>
        )}

        <button
          className="shrink-0 rounded-xs p-0.5 transition-colors hover:bg-white/10"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3 text-white/30" />
          ) : (
            <ChevronRightIcon className="size-3 text-white/20" />
          )}
        </button>
      </div>

      {expanded && step.filePath && (
        <div className="ml-5 overflow-hidden rounded-xs border border-white/5 bg-[#0d0d0d]">
          {showDiff &&
          canShowDiff &&
          step.originalContent &&
          step.modifiedContent ? (
            <InlineDiffView
              language={inferLanguage(step.filePath)}
              modified={step.modifiedContent}
              original={step.originalContent}
            />
          ) : (
            <BorderlessFileView
              filePath={step.filePath}
              height="200px"
              language={inferLanguage(step.filePath)}
              value={
                step.modifiedContent ??
                step.content ??
                `// File: ${step.filePath}\n// Content will appear here once the agent provides it`
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ step }: { step: AgentStep }) {
  const meta = STEP_META[step.kind];
  const Icon = meta.icon;
  const isRunning = step.status === "running";

  return (
    <div className="flex items-center gap-2">
      {isRunning ? (
        <Loader2Icon className="size-3 shrink-0 animate-spin text-white/40" />
      ) : (
        <CheckCircle2Icon className="size-3 shrink-0 text-white/20" />
      )}

      <Icon className={cn("size-3 shrink-0", meta.color)} />
      <span
        className={cn(
          "font-medium text-[0.65rem] uppercase tracking-wider",
          meta.color
        )}
      >
        {meta.label}
      </span>

      <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] text-white/60">
        {step.summary}
      </span>
    </div>
  );
}

function GroupedStepRow({ group }: { group: GroupedStep }) {
  switch (group.kind) {
    case "thinking":
      return <GroupedThinkingBlock group={group} />;
    case "response":
      return <GroupedResponseBlock group={group} />;
    case "file_edit":
      return <ChangesBlock step={group.step} />;
    case "tool_call":
    case "command":
      return <ToolCallRow step={group.step} />;
    default:
      return null;
  }
}

interface AgentOutputCardProps {
  accentClass?: string;
  boardId: string;
  className?: string;
  isActive: boolean;
  run?: AgentRunContext;
  taskId: string;
  taskTitle: string;
}

export function AgentOutputCard({
  boardId,
  isActive,
  run,
  taskId,
  taskTitle,
  accentClass: _accentClass = "bg-primary-light",
  className,
}: AgentOutputCardProps) {
  const steps = run?.steps ?? EMPTY_AGENT_STEPS;
  const doneCount = steps.filter((s) => s.status === "done").length;
  const progressPercent =
    steps.length === 0 ? 0 : Math.round((doneCount / steps.length) * 100);
  const groupedSteps = useMemo(() => groupSteps(steps), [steps]);
  const [aborting, setAborting] = useState(false);
  const [stopAccepted, setStopAccepted] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive) {
      setStopAccepted(false);
    }
  }, [isActive]);

  const handleAbort = useCallback(async () => {
    if (aborting || stopAccepted) {
      return;
    }
    setAborting(true);
    setAbortError(null);
    try {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/abort`,
        { method: "POST" }
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error = apiErrorSchema.safeParse(payload);
        throw new Error(
          error.success
            ? error.data.message
            : "Could not stop this task. Try again."
        );
      }
      const accepted = acceptedCommandResponseSchema.safeParse(payload);
      if (accepted.success && !accepted.data.accepted) {
        throw new Error(
          "The engine did not accept the stop request. The task is still running."
        );
      }
      setStopAccepted(true);
    } catch (error) {
      setAbortError(
        error instanceof Error
          ? error.message
          : "Could not stop this task. Try again."
      );
    } finally {
      setAborting(false);
    }
  }, [boardId, taskId, aborting, stopAccepted]);

  return (
    <div
      className={cn(
        "flex flex-col gap-0 overflow-hidden rounded-sm border border-white/10 bg-white/2",
        className
      )}
    >
      <div className="flex items-center gap-2 border-white/8 border-b bg-white/1.5 px-3 py-2">
        <span className="relative flex size-2">
          {isActive && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-50" />
          )}
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              isActive ? "bg-sky-400" : "bg-white/20"
            )}
          />
        </span>

        <span className="min-w-0 flex-1 truncate font-medium text-[0.7rem] text-white/70">
          {taskTitle}
        </span>

        {run?.model && (
          <span className="shrink-0 rounded-xs border border-white/8 bg-white/5 px-1.5 py-0.5 font-mono text-[0.6rem] text-white/40">
            {run.model}
          </span>
        )}

        {isActive && (
          <button
            className={cn(
              "flex items-center gap-1 rounded-xs border px-1.5 py-0.5 font-medium text-[0.6rem] transition-colors",
              aborting || stopAccepted
                ? "cursor-not-allowed border-white/10 bg-white/5 text-white/20"
                : "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300"
            )}
            disabled={aborting || stopAccepted}
            onClick={handleAbort}
            title="Interrupt agent"
            type="button"
          >
            <SquareIcon className="size-2.5" />
            {aborting || stopAccepted ? "Stopping" : "Stop"}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3 px-3 py-3">
        {groupedSteps.map((group) => {
          const stepId =
            group.kind === "thinking" || group.kind === "response"
              ? group.id
              : group.step.id;
          return <GroupedStepRow group={group} key={stepId} />;
        })}
        {steps.length === 0 && (
          <p className="text-[0.68rem] text-white/35" role="status">
            Waiting for the agent to send its first update…
          </p>
        )}
      </div>

      {abortError && (
        <p
          className="border-rose-500/15 border-t bg-rose-500/[0.03] px-3 py-2 text-[0.68rem] text-rose-300/85"
          role="alert"
        >
          {abortError}
        </p>
      )}

      <div className="flex items-center gap-3 border-white/5 border-t px-3 py-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/8">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              isActive ? "bg-sky-500" : "bg-white/30"
            )}
            style={{
              width: `${progressPercent}%`,
            }}
          />
        </div>
        <span className="shrink-0 text-[0.65rem] text-white/30 tabular-nums">
          {steps.length === 0
            ? `Waiting · ${run?.elapsed ?? "…"}`
            : `${doneCount}/${steps.length} steps · ${run?.elapsed ?? ""}`}
        </span>
      </div>
    </div>
  );
}
