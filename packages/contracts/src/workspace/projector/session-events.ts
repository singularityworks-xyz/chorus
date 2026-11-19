import type { WorkspaceBoard } from "../base";
import type { WorkspaceColumnId } from "../events";
import {
  resolveTaskId,
  type SessionScopedEvent,
  unhandledBoardEvent,
} from "./routing";
import { extractPlanFromSteps } from "./run-state";
import {
  findTaskInColumns,
  moveCard,
  taskNeedsManualReview,
  withTaskUpdated,
} from "./task-state";

export function applySessionEvent(
  board: WorkspaceBoard,
  event: SessionScopedEvent
): WorkspaceBoard {
  switch (event.type) {
    case "session.starting":
      return { ...board, session: { ...board.session, state: "starting" } };

    case "session.attached": {
      const taskId = event.taskId ?? board.session.currentTaskId;
      const columns = taskId
        ? withTaskUpdated(board.columns, taskId, (task) => ({
            ...task,
            runId: event.sessionId,
            run: task.run
              ? { ...task.run, sessionId: event.sessionId }
              : task.run,
          }))
        : board.columns;

      return {
        ...board,
        columns,
        session: {
          ...board.session,
          errorMessage: undefined,
          sessionId: event.sessionId,
          state: "active",
        },
      };
    }

    case "session.idle": {
      const taskId = resolveTaskId(event, board);
      if (!taskId) {
        return board;
      }

      const task = findTaskInColumns(board.columns, taskId);
      const isManualReview = taskNeedsManualReview(task, board.reviewMode);
      const targetColumn: WorkspaceColumnId = isManualReview
        ? "approve"
        : "done";
      const planText = extractPlanFromSteps(task?.run?.steps ?? []);

      let columns = moveCard(board.columns, taskId, targetColumn);
      if (task) {
        columns = withTaskUpdated(columns, taskId, (entry) => ({
          ...entry,
          outcome: isManualReview ? "awaiting_review" : "succeeded",
          reviewApproved: isManualReview ? false : entry.reviewApproved,
        }));
      }
      if (isManualReview && planText && task) {
        columns = withTaskUpdated(columns, taskId, (entry) => ({
          ...entry,
          plan: planText,
        }));
      }

      return {
        ...board,
        columns,
        session: {
          ...board.session,
          currentTaskId: undefined,
          state: "active",
        },
      };
    }

    case "session.error": {
      const taskId = event.taskId ?? board.session.currentTaskId;
      return {
        ...board,
        columns: taskId
          ? withTaskUpdated(
              moveCard(board.columns, taskId, "done"),
              taskId,
              (task) => ({
                ...task,
                pendingApproval: undefined,
                pendingApprovals: [],
                errorMessage: event.error,
                outcome: "failed",
              })
            )
          : board.columns,
        session: {
          ...board.session,
          currentTaskId: undefined,
          errorMessage: event.error,
          state: "error",
        },
      };
    }

    case "session.timeout": {
      const taskId = event.taskId ?? board.session.currentTaskId;
      return {
        ...board,
        columns: taskId
          ? withTaskUpdated(
              moveCard(board.columns, taskId, "done"),
              taskId,
              (task) => ({
                ...task,
                pendingApproval: undefined,
                pendingApprovals: [],
                errorMessage: event.error,
                outcome: "timed_out",
              })
            )
          : board.columns,
        session: {
          ...board.session,
          currentTaskId: undefined,
          errorMessage: event.error,
        },
      };
    }

    default:
      return unhandledBoardEvent(event, board);
  }
}
