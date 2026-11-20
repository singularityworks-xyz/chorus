"use client";

import {
  BrainIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FilePenLineIcon,
  Loader2Icon,
  MessageSquareIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "../utils/copy-text-to-clipboard";
import { ChangesBlock } from "./file-edits";
import type { GroupedStep } from "./group-steps";
import { StreamedContentPanel } from "./streamed-content-panel";
import type { AgentStep, AgentStepKind } from "./types";

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
        <StreamedContentPanel
          className="border-violet-500/10 bg-violet-500/[0.03] text-violet-300/60"
          content={displayedContent}
          kind="thinking"
        />
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
        <StreamedContentPanel
          className="border-sky-500/10 bg-sky-500/[0.03] text-sky-300/70"
          content={displayedContent}
          kind="response"
        />
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

export function GroupedStepRow({ group }: { group: GroupedStep }) {
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
