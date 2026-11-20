"use client";

import type { Task } from "@chorus/contracts";
import {
  BrainIcon,
  CogIcon,
  MessageSquareIcon,
  PlusIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type GroupedStep, groupSteps } from "../agent-output/group-steps";
import type { AgentStep } from "../agent-output/types";
import type { ChangedFile } from "../types";

export function extractChangedFiles(steps: AgentStep[]): ChangedFile[] {
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

export function getTaskDiffSummary(task: Task) {
  if (task.run) {
    return {
      changedFiles: extractChangedFiles(task.run.steps),
      diffTotals: computeDiffTotals(task.run.steps),
    };
  }

  return {
    changedFiles: task.changedFiles ?? [],
    diffTotals: {
      added: task.linesAdded ?? 0,
      removed: task.linesRemoved ?? 0,
    },
  };
}

export function FilePill({ path }: { path: string }) {
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

export function ChangedFileRow({ file }: { file: ChangedFile }) {
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

export function DoneGroupedStepRow({ group }: { group: GroupedStep }) {
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

export function TaskCardDiffSection({
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

export function TaskCardDoneSummary({
  changedFiles,
  diffTotals,
  showDone,
  task,
}: {
  changedFiles: ChangedFile[];
  diffTotals: { added: number; removed: number };
  showDone: boolean;
  task: Task;
}) {
  if (!showDone) {
    return null;
  }

  return (
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
  );
}
