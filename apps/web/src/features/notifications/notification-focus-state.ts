import type {
  WorkspaceBoard,
  WorkspaceContextValue,
} from "@/features/workspace/types";

type NotificationFocusDecision =
  | { state: "wait" }
  | { state: "unavailable" }
  | { boardId: string; cardId: string; state: "focus" };

export function notificationFocusDecision(input: {
  boardId: string | null;
  boards: Pick<WorkspaceBoard, "boardId">[];
  cardId: string | null;
  sessionStatus: WorkspaceContextValue["sessionStatus"];
}): NotificationFocusDecision {
  if (input.sessionStatus !== "live") {
    return { state: "wait" };
  }

  if (
    !(
      input.boardId &&
      input.cardId &&
      input.boards.some((board) => board.boardId === input.boardId)
    )
  ) {
    return { state: "unavailable" };
  }

  return {
    boardId: input.boardId,
    cardId: input.cardId,
    state: "focus",
  };
}
