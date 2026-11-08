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
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "../utils/copy-text-to-clipboard";
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

export function getFilePreviewContent(step: AgentStep) {
  return step.modifiedContent ?? step.content;
}

const FILE_CONTENT_UNAVAILABLE_MESSAGES: Record<AgentStepStatus, string> = {
  done: "The agent completed this edit without sending file contents.",
  error: "File contents are unavailable because this edit failed.",
  running: "Waiting for the agent to send file contents.",
};

export function FileContentUnavailable({
  status,
}: {
  status: AgentStepStatus;
}) {
  return (
    <p
      className="flex h-[200px] items-center justify-center px-4 text-center text-[0.7rem] text-white/40"
      role={status === "error" ? "alert" : "status"}
    >
      {FILE_CONTENT_UNAVAILABLE_MESSAGES[status]}
    </p>
  );
}

const EMPTY_AGENT_STEPS: AgentStep[] = [];
const MARKDOWN_PLUGINS = [remarkGfm];
const MARKDOWN_REFRESH_INTERVAL_MS = 100;
const COPY_STATE_PRESENTATION = {
  copying: {
    iconClass: "text-white/30",
    label: "Copy response",
    title: "Copy response",
  },
  copied: {
    iconClass: "text-emerald-400",
    label: "Response copied",
    title: "Response copied",
  },
  error: {
    iconClass: "text-rose-400",
    label: "Copy response failed",
    title: "Could not copy. Select the response and copy it manually.",
  },
  idle: {
    iconClass: "text-white/30",
    label: "Copy response",
    title: "Copy response",
  },
} as const;

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
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} thinking details`}
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
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "error"
  >("idle");
  const copyTimeout = useRef<number | null>(null);
  const mounted = useRef(false);
  const copyPresentation = COPY_STATE_PRESENTATION[copyState];
  const hasContent = group.content && group.content.length > 0;
  const stepCount = group.sourceSteps.length;
  const displayedContent = useStreamedMarkdownContent(
    group.content,
    isRunning && expanded
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copyTimeout.current !== null) {
        window.clearTimeout(copyTimeout.current);
        copyTimeout.current = null;
      }
    };
  }, []);

  async function handleCopy() {
    if (!group.content || copyState === "copying") {
      return;
    }

    if (copyTimeout.current !== null) {
      window.clearTimeout(copyTimeout.current);
      copyTimeout.current = null;
    }

    setCopyState("copying");
    try {
      await copyTextToClipboard(
        group.content,
        typeof navigator === "undefined" ? undefined : navigator.clipboard
      );
      if (!mounted.current) {
        return;
      }
      setCopyState("copied");
      copyTimeout.current = window.setTimeout(() => {
        setCopyState("idle");
        copyTimeout.current = null;
      }, 2000);
    } catch {
      if (mounted.current) {
        setCopyState("error");
      }
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
              aria-label={copyPresentation.label}
              className="shrink-0 rounded-xs p-0.5 transition-colors hover:bg-white/10 disabled:cursor-wait"
              disabled={copyState === "copying"}
              onClick={handleCopy}
              title={copyPresentation.title}
              type="button"
            >
              <CopyIcon className={cn("size-3", copyPresentation.iconClass)} />
            </button>
            <button
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} response`}
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

      {copyState === "error" && (
        <p className="ml-5 text-[0.65rem] text-rose-300/85" role="alert">
          Could not copy the response. Select the text and copy it manually.
        </p>
      )}
      {copyState === "copied" && (
        <span className="sr-only" role="status">
          Response copied to clipboard.
        </span>
      )}

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

export function FileEditContents({
  canShowDiff,
  filePath,
  showDiff,
  step,
}: {
  canShowDiff: boolean;
  filePath: string;
  showDiff: boolean;
  step: AgentStep;
}) {
  if (
    showDiff &&
    canShowDiff &&
    step.originalContent !== undefined &&
    step.modifiedContent !== undefined
  ) {
    return (
      <InlineDiffView
        language={inferLanguage(filePath)}
        modified={step.modifiedContent}
        original={step.originalContent}
      />
    );
  }

  const fileContent = getFilePreviewContent(step);
  if (fileContent === undefined) {
    return <FileContentUnavailable status={step.status} />;
  }

  return (
    <BorderlessFileView
      filePath={filePath}
      height="200px"
      language={inferLanguage(filePath)}
      value={fileContent}
    />
  );
}

function ChangesBlock({ step }: { step: AgentStep }) {
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const hasOriginal = step.originalContent !== undefined;
  const hasModified = step.modifiedContent !== undefined;
  const hasActualChanges =
    (step.linesAdded ?? 0) > 0 || (step.linesRemoved ?? 0) > 0;
  const canShowDiff = hasOriginal && hasModified && hasActualChanges;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {step.status === "running" && (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-emerald-400/60" />
        )}
        {step.status === "error" && (
          <TriangleAlertIcon
            aria-hidden="true"
            className="size-3 shrink-0 text-red-400/80"
          />
        )}
        {step.status === "done" && (
          <CheckCircle2Icon
            aria-hidden="true"
            className="size-3 shrink-0 text-white/20"
          />
        )}

        <FilePenLineIcon className="size-3 shrink-0 text-emerald-400" />
        <span className="font-medium text-[0.65rem] text-emerald-400 uppercase tracking-wider">
          {step.status === "error" ? "Edit failed" : "Edit"}
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
            aria-expanded={showDiff}
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
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${step.filePath ?? "file change"}`}
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
          <FileEditContents
            canShowDiff={canShowDiff}
            filePath={step.filePath}
            showDiff={showDiff}
            step={step}
          />
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
