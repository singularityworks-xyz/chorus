"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceBoard } from "@/features/workspace/types";

export function useBoardRemoval({
  boards,
  removeBoard,
  selectedBoardId,
}: {
  boards: WorkspaceBoard[];
  removeBoard: (boardId: string) => Promise<void>;
  selectedBoardId: string | null;
}) {
  const [removingBoardId, setRemovingBoardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const removeInFlightRef = useRef(false);

  useEffect(() => {
    if (
      !removingBoardId ||
      boards.some((board) => board.boardId === removingBoardId)
    ) {
      return;
    }

    removeInFlightRef.current = false;
    setRemovingBoardId(null);
  }, [boards, removingBoardId]);

  const remove = useCallback(
    async (boardId: string) => {
      if (removeInFlightRef.current) {
        return;
      }

      removeInFlightRef.current = true;
      setRemovingBoardId(boardId);
      setError(null);
      try {
        await removeBoard(boardId);
      } catch {
        removeInFlightRef.current = false;
        setRemovingBoardId(null);
        setError("Could not remove this board. It remains open; try again.");
      }
    },
    [removeBoard]
  );

  const removeSelected = useCallback(() => {
    if (selectedBoardId) {
      return remove(selectedBoardId);
    }
  }, [remove, selectedBoardId]);

  const dismissError = useCallback(() => setError(null), []);

  return {
    dismissError,
    error,
    remove,
    removeSelected,
    removingBoardId,
  };
}
