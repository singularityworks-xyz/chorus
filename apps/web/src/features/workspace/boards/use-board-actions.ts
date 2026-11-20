import type { WorkspaceMutation } from "@chorus/contracts";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceMutationFactory } from "../actions/use-workspace-mutation";
import type { WorkspaceAction, WorkspaceState } from "../reducer";
import { isCurrentBoardSelection } from "../state";
import type { WorkspaceContextValue } from "../types";

export function useBoardActions({
  createMutation,
  dispatch,
  mutateWorkspace,
  state,
}: {
  createMutation: WorkspaceMutationFactory;
  dispatch: React.Dispatch<WorkspaceAction>;
  mutateWorkspace: (mutation: WorkspaceMutation) => Promise<void>;
  state: WorkspaceState;
}) {
  const [localBoardFocus, setLocalBoardFocus] = useState<string | null>(null);
  const selectedBoardId = localBoardFocus ?? state.selectedBoardId;
  const selectedBoard = state.boards.find(
    (board) => board.boardId === selectedBoardId
  );

  useEffect(() => {
    if (
      localBoardFocus &&
      !state.boards.some((board) => board.boardId === localBoardFocus)
    ) {
      setLocalBoardFocus(null);
    }
  }, [localBoardFocus, state.boards]);

  const removeBoard = useCallback(
    (boardId: string) =>
      mutateWorkspace(
        createMutation({ type: "board.remove", payload: { boardId } })
      ),
    [createMutation, mutateWorkspace]
  );

  const selectBoard = useCallback(
    (boardId: string) => {
      setLocalBoardFocus(null);
      dispatch({ boardId, type: "optimistic/drag-settle" });
      if (isCurrentBoardSelection(state.selectedBoardId, boardId)) {
        return;
      }
      mutateWorkspace(
        createMutation({ type: "board.select", payload: { boardId } })
      ).catch((error: unknown) => {
        console.error("Failed to select board:", error);
      });
    },
    [createMutation, dispatch, mutateWorkspace, state.selectedBoardId]
  );

  const focusBoardLocally = useCallback((boardId: string) => {
    setLocalBoardFocus(boardId);
  }, []);

  const clearSelection = useCallback(() => {
    mutateWorkspace(
      createMutation({ type: "board.select", payload: { boardId: null } })
    ).catch((error: unknown) => {
      console.error("Failed to clear selection:", error);
    });
  }, [createMutation, mutateWorkspace]);

  const updateBoardPosition = useCallback(
    (boardId: string, position: { x: number; y: number }) => {
      const mutation = createMutation({
        type: "board.move",
        payload: { boardId, position },
      });

      dispatch({
        boardId,
        mutationId: mutation.mutationId,
        position,
        type: "optimistic/drag",
      });

      mutateWorkspace(mutation).catch((error: unknown) => {
        dispatch({ boardId, type: "optimistic/drag-settle" });
        console.error("Failed to update board position:", error);
      });
    },
    [createMutation, dispatch, mutateWorkspace]
  );

  const reorderBoardTask = useCallback(
    (
      boardId: string,
      taskId: string,
      column: Parameters<WorkspaceContextValue["reorderBoardTask"]>[2],
      beforeTaskId: string | null
    ) =>
      mutateWorkspace(
        createMutation({
          type: "board.task.reorder",
          payload: { beforeTaskId, boardId, column, taskId },
        })
      ),
    [createMutation, mutateWorkspace]
  );

  const updateBoardReviewMode = useCallback(
    (
      boardId: string,
      reviewMode: Parameters<WorkspaceContextValue["updateBoardReviewMode"]>[1]
    ) =>
      mutateWorkspace(
        createMutation({
          type: "board.review_mode.set",
          payload: { boardId, reviewMode },
        })
      ),
    [createMutation, mutateWorkspace]
  );

  const setBoardModel = useCallback(
    (
      boardId: string,
      model: Parameters<WorkspaceContextValue["setBoardModel"]>[1]
    ) => {
      mutateWorkspace(
        createMutation({ type: "board.model.set", payload: { boardId, model } })
      ).catch((error: unknown) => {
        console.error("Failed to set board model:", error);
      });
    },
    [createMutation, mutateWorkspace]
  );

  return {
    clearSelection,
    focusBoardLocally,
    removeBoard,
    selectBoard,
    selectedBoard,
    selectedBoardId,
    setBoardModel,
    updateBoardPosition,
    updateBoardReviewMode,
    reorderBoardTask,
  };
}
