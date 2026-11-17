"use client";

import type { BoardSessionHistoryCommand } from "@chorus/contracts";
import { LoaderCircleIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { useCallback } from "react";
import { useBoardSessionHistory } from "@/features/kanban/hooks/use-board-session-history";
import { cn } from "@/lib/utils";

interface BoardSessionHistoryActionsProps {
  boardBusy: boolean;
  canRedo: boolean;
  canUndo: boolean;
  error: string | null;
  isLoading: boolean;
  onRefresh: () => void | Promise<void>;
  onRunCommand: (command: BoardSessionHistoryCommand) => void | Promise<void>;
  pendingCommand: BoardSessionHistoryCommand | null;
}

export function BoardSessionHistoryActions({
  boardBusy,
  canRedo,
  canUndo,
  error,
  isLoading,
  onRefresh,
  onRunCommand,
  pendingCommand,
}: BoardSessionHistoryActionsProps) {
  const historyDisabled = boardBusy || isLoading || Boolean(pendingCommand);

  return (
    <>
      <div className="nodrag flex items-center gap-1">
        <button
          aria-label="Undo repository changes"
          className={cn(
            "rounded-xs p-1 transition-colors",
            canUndo && !historyDisabled
              ? "text-white/50 hover:bg-white/10 hover:text-white/80"
              : "cursor-not-allowed text-white/15"
          )}
          disabled={!canUndo || historyDisabled}
          onClick={() => onRunCommand("undo")}
          title={
            pendingCommand === "undo"
              ? "Undoing repository changes"
              : "Undo repository changes"
          }
          type="button"
        >
          {pendingCommand === "undo" ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <Undo2Icon className="size-3.5" />
          )}
        </button>
        <button
          aria-label="Redo repository changes"
          className={cn(
            "rounded-xs p-1 transition-colors",
            canRedo && !historyDisabled
              ? "text-white/50 hover:bg-white/10 hover:text-white/80"
              : "cursor-not-allowed text-white/15"
          )}
          disabled={!canRedo || historyDisabled}
          onClick={() => onRunCommand("redo")}
          title={
            pendingCommand === "redo"
              ? "Redoing repository changes"
              : "Redo repository changes"
          }
          type="button"
        >
          {pendingCommand === "redo" ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <Redo2Icon className="size-3.5" />
          )}
        </button>
      </div>

      {(error || boardBusy) && (
        <div
          className={cn(
            "flex items-center justify-between gap-2 border-white/8 border-b px-3 py-1.5 text-[0.65rem]",
            error
              ? "bg-red-400/8 text-red-200/90"
              : "bg-amber-300/6 text-amber-100/75"
          )}
          role={error ? "alert" : "status"}
        >
          <span className="min-w-0 truncate">
            {error ??
              "Finish current work or review before changing repository history."}
          </span>
          <button
            className="shrink-0 underline underline-offset-2"
            onClick={onRefresh}
            type="button"
          >
            {error ? "Retry" : "Refresh"}
          </button>
        </div>
      )}
    </>
  );
}

export function BoardSessionHistoryControls({
  boardBusy,
  boardId,
  sessionId,
}: {
  boardBusy: boolean;
  boardId: string;
  sessionId?: string;
}) {
  const {
    busy,
    canRedo,
    canUndo,
    error,
    isLoading,
    pendingCommand,
    refresh,
    runCommand,
  } = useBoardSessionHistory(boardId, sessionId, boardBusy);

  const handleRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return (
    <BoardSessionHistoryActions
      boardBusy={busy}
      canRedo={canRedo}
      canUndo={canUndo}
      error={error}
      isLoading={isLoading}
      onRefresh={handleRefresh}
      onRunCommand={runCommand}
      pendingCommand={pendingCommand}
    />
  );
}
