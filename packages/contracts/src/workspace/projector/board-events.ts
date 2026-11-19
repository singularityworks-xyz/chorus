import type { WorkspaceBoard } from "../base/boards";
import { type BoardLifecycleEvent, unhandledBoardEvent } from "./routing";
import { normalizeColumns, withTaskUpdated } from "./task-state";

export function applyBoardScopedEvent(
  board: WorkspaceBoard,
  event: BoardLifecycleEvent
): WorkspaceBoard {
  switch (event.type) {
    case "board.moved":
      return { ...board, position: event.position };

    case "board.review_mode_set":
      return { ...board, reviewMode: event.reviewMode };

    case "board.model_set":
      return { ...board, modelSelection: event.model };

    case "board.columns_replaced":
      return { ...board, columns: normalizeColumns(event.columns) };

    case "board.session_patched":
      return { ...board, session: { ...board.session, ...event.session } };

    case "board.task_plan_updated":
      return {
        ...board,
        columns: withTaskUpdated(board.columns, event.taskId, (task) => ({
          ...task,
          ...(event.errorMessage === undefined
            ? {}
            : { errorMessage: event.errorMessage ?? undefined }),
          plan: event.plan,
          questionAnswers: event.questionAnswers ?? task.questionAnswers,
          questions: event.questions ?? task.questions,
          reviewApproved: event.reviewApproved ?? task.reviewApproved,
        })),
      };
    case "board.created":
    case "board.removed":
      return board;

    default:
      return unhandledBoardEvent(event, board);
  }
}
