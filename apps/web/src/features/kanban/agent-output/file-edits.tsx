"use client";

import { BorderlessFileView, InlineDiffView } from "@chorus/monaco";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  FilePenLineIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AgentStep, AgentStepStatus } from "./types";

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

export function ChangesBlock({ step }: { step: AgentStep }) {
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
