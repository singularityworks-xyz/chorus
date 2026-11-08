"use client";

import type {
  BoardSessionHistoryCommand,
  BoardSessionHistoryState,
} from "@chorus/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { loadBoardSessionHistory } from "../board-session-history-client";

export function useBoardSessionHistory(
  boardId: string,
  sessionId?: string,
  boardBusy = false
) {
  const { sessionCommand, sessionHistoryChange } = useWorkspace();
  const requestVersion = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const pendingCommandRef = useRef<BoardSessionHistoryCommand | null>(null);
  const previousBoardBusy = useRef(boardBusy);
  const notifiedHistoryRevision = useRef<number | null>(null);
  const [history, setHistory] = useState<BoardSessionHistoryState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingCommand, setPendingCommand] =
    useState<BoardSessionHistoryCommand | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    setIsLoading(true);
    setError(null);

    try {
      const currentHistory = await loadBoardSessionHistory(boardId, sessionId, {
        signal: controller.signal,
      });
      if (requestVersion.current === version) {
        setHistory(currentHistory);
      }
    } catch (cause) {
      if (requestVersion.current === version && !controller.signal.aborted) {
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
      if (refreshController.current === controller) {
        refreshController.current = null;
      }
    }
  }, [boardId, sessionId]);

  useEffect(() => {
    setHistory(null);
    setError(null);
    setIsLoading(true);
    pendingCommandRef.current = null;
    setPendingCommand(null);
    refresh();
    return () => {
      requestVersion.current += 1;
      refreshController.current?.abort();
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
    refresh();
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
      if (pendingCommandRef.current) {
        return;
      }

      pendingCommandRef.current = command;
      setPendingCommand(command);
      setError(null);
      try {
        const result = await sessionCommand(boardId, command);
        if (!result.ok) {
          await refresh();
          setError(result.error ?? `Could not ${command} repository changes.`);
          return;
        }

        await refresh();
      } catch (cause) {
        await refresh();
        setError(
          cause instanceof Error
            ? cause.message
            : `Could not ${command} repository changes. Refresh and retry.`
        );
      } finally {
        pendingCommandRef.current = null;
        setPendingCommand(null);
      }
    },
    [boardId, refresh, sessionCommand]
  );

  const historyMatchesBoard =
    history?.boardId === boardId && history.sessionId === (sessionId ?? null);

  return {
    busy: boardBusy || Boolean(historyMatchesBoard && history.busy),
    canRedo: Boolean(
      historyMatchesBoard && history.canRedo && !history.busy && !boardBusy
    ),
    canUndo: Boolean(
      historyMatchesBoard && history.canUndo && !history.busy && !boardBusy
    ),
    error,
    isLoading: isLoading || !historyMatchesBoard,
    pendingCommand,
    refresh,
    runCommand,
  };
}
