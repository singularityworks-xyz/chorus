"use client";

import {
  apiErrorSchema,
  type BoardSessionHistoryCommand,
  type BoardSessionHistoryState,
  boardSessionHistoryStateSchema,
} from "@chorus/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-context";

function historyRequestError(payload: unknown, fallback: string): string {
  const parsed = apiErrorSchema.safeParse(payload);
  return parsed.success ? parsed.data.message : fallback;
}

export function useBoardSessionHistory(
  boardId: string,
  sessionId?: string,
  boardBusy = false
) {
  const { sessionCommand, sessionHistoryChange } = useWorkspace();
  const requestVersion = useRef(0);
  const previousBoardBusy = useRef(boardBusy);
  const notifiedHistoryRevision = useRef<number | null>(null);
  const [history, setHistory] = useState<BoardSessionHistoryState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingCommand, setPendingCommand] =
    useState<BoardSessionHistoryCommand | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(boardId)}/session/history`,
        { cache: "no-store" }
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(
          historyRequestError(
            payload,
            "Could not load repository history. Check the board connection and retry."
          )
        );
      }

      const parsed = boardSessionHistoryStateSchema.safeParse(payload);
      if (
        !parsed.success ||
        parsed.data.boardId !== boardId ||
        parsed.data.sessionId !== (sessionId ?? null)
      ) {
        throw new Error(
          "The repository history response did not match this board. Refresh the workspace and retry."
        );
      }

      if (requestVersion.current === version) {
        setHistory(parsed.data);
      }
    } catch (cause) {
      if (requestVersion.current === version) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load repository history. Check the board connection and retry."
        );
        setHistory(null);
      }
    } finally {
      if (requestVersion.current === version) {
        setIsLoading(false);
      }
    }
  }, [boardId, sessionId]);

  useEffect(() => {
    refresh();
    return () => {
      requestVersion.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (previousBoardBusy.current === boardBusy) {
      return;
    }
    previousBoardBusy.current = boardBusy;
    refresh();
  }, [boardBusy, refresh]);

  useEffect(() => {
    if (
      !sessionHistoryChange ||
      sessionHistoryChange.boardId !== boardId ||
      notifiedHistoryRevision.current === sessionHistoryChange.revision
    ) {
      return;
    }
    notifiedHistoryRevision.current = sessionHistoryChange.revision;
    refresh().then(() => setPendingCommand(null));
  }, [boardId, refresh, sessionHistoryChange]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  const runCommand = useCallback(
    async (command: BoardSessionHistoryCommand) => {
      if (pendingCommand) {
        return;
      }

      setPendingCommand(command);
      setError(null);
      const result = await sessionCommand(boardId, command);
      if (!result.ok) {
        await refresh();
        setError(result.error ?? `Could not ${command} repository changes.`);
        setPendingCommand(null);
      }
    },
    [boardId, pendingCommand, refresh, sessionCommand]
  );

  return {
    busy: boardBusy || Boolean(history?.busy),
    canRedo: Boolean(history?.canRedo && !history.busy && !boardBusy),
    canUndo: Boolean(history?.canUndo && !history.busy && !boardBusy),
    error,
    isLoading,
    pendingCommand,
    refresh,
    runCommand,
  };
}
