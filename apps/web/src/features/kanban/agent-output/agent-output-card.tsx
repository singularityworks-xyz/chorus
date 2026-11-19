"use client";

import { SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { abortBoardTask } from "../task-abort-client";
import { groupSteps } from "./group-steps";
import { GroupedStepRow } from "./step-rows";
import type { AgentRunContext, AgentStep } from "./types";

const EMPTY_AGENT_STEPS: AgentStep[] = [];

interface AgentOutputCardProps {
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
  const abortInFlight = useRef(false);

  useEffect(() => {
    if (!isActive) {
      setStopAccepted(false);
    }
  }, [isActive]);

  const handleAbort = useCallback(async () => {
    if (abortInFlight.current || stopAccepted) {
      return;
    }
    abortInFlight.current = true;
    setAborting(true);
    setAbortError(null);
    try {
      await abortBoardTask(boardId, taskId);
      setStopAccepted(true);
    } catch (error) {
      setAbortError(
        error instanceof Error
          ? error.message
          : "Could not stop this task. Refresh the board and try again."
      );
    } finally {
      abortInFlight.current = false;
      setAborting(false);
    }
  }, [boardId, taskId, stopAccepted]);

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
