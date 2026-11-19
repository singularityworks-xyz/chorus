import type { WorkspaceBoard } from "../base";
import { type CardRunStepEvent, unhandledBoardEvent } from "./routing";
import {
  appendDelta,
  ensureRun,
  formatElapsed,
  upsertStep,
  withRun,
} from "./run-state";
import {
  makeLabelVariant,
  moveCard,
  normalizeColumns,
  reorderCard,
  withColumns,
  withTaskUpdated,
} from "./task-state";

export function applyCardEvent(
  board: WorkspaceBoard,
  event: CardRunStepEvent,
  now: number
): WorkspaceBoard {
  switch (event.type) {
    case "card.created": {
      const columns = normalizeColumns(board.columns);
      return {
        ...board,
        columns: {
          ...columns,
          [event.column]: [
            ...columns[event.column],
            { ...event.task, labelVariant: makeLabelVariant(event.column) },
          ],
        },
        session: { ...board.session, currentTaskId: event.taskId },
      };
    }

    case "card.queued": {
      if (!event.task) {
        return withColumns(
          board,
          moveCard(board.columns, event.taskId, event.column)
        );
      }
      const queued = moveCard(board.columns, event.taskId, "queue");
      return withColumns(
        board,
        withTaskUpdated(queued, event.taskId, (task) => event.task ?? task)
      );
    }

    case "card.started":
      return withColumns(
        board,
        withTaskUpdated(
          moveCard(board.columns, event.taskId, "in_progress"),
          event.taskId,
          (task) => task
        )
      );

    case "card.moved":
      return withColumns(
        board,
        moveCard(board.columns, event.taskId, event.column)
      );

    case "card.reordered":
      return withColumns(
        board,
        reorderCard(
          board.columns,
          event.taskId,
          event.column,
          event.beforeTaskId
        )
      );

    case "card.waiting_for_approval":
      return withColumns(
        board,
        withTaskUpdated(
          moveCard(board.columns, event.taskId, "approve"),
          event.taskId,
          (task) => {
            if (!event.pendingApproval) {
              return task;
            }
            const existing =
              task.pendingApprovals ??
              (task.pendingApproval ? [task.pendingApproval] : []);
            const requestId =
              event.requestId ?? event.pendingApproval.requestId;
            const pending = requestId
              ? existing.filter((entry) => entry.requestId !== requestId)
              : existing.filter(
                  (entry) => entry.kind !== event.pendingApproval?.kind
                );
            const next = [
              ...pending,
              { ...event.pendingApproval, ...(requestId ? { requestId } : {}) },
            ];
            return {
              ...task,
              pendingApproval: event.pendingApproval,
              pendingApprovals: next,
            };
          }
        )
      );

    case "card.approval_resolved":
      return withColumns(
        board,
        withTaskUpdated(board.columns, event.taskId, (task) => {
          const existing =
            task.pendingApprovals ??
            (task.pendingApproval ? [task.pendingApproval] : []);
          const pending = existing.filter(
            (entry) => entry.requestId !== event.requestId
          );
          if (pending.length === existing.length) {
            return task;
          }
          return {
            ...task,
            pendingApproval:
              task.pendingApproval?.requestId === event.requestId
                ? pending.at(-1)
                : task.pendingApproval,
            pendingApprovals: pending,
          };
        })
      );

    case "card.completed": {
      const columns = withTaskUpdated(
        moveCard(board.columns, event.taskId, "done"),
        event.taskId,
        (task) => ({
          ...task,
          pendingApproval: undefined,
          pendingApprovals: [],
          outcome: "succeeded",
          errorMessage: undefined,
        })
      );
      const releasesTask = board.session.currentTaskId === event.taskId;
      if (columns === board.columns && !releasesTask) {
        return board;
      }
      return {
        ...board,
        columns,
        session: releasesTask
          ? { ...board.session, currentTaskId: undefined }
          : board.session,
      };
    }

    case "card.failed":
      return {
        ...board,
        columns: withTaskUpdated(
          moveCard(board.columns, event.taskId, "done"),
          event.taskId,
          (task) => ({
            ...task,
            pendingApproval: undefined,
            pendingApprovals: [],
            errorMessage: event.error,
            outcome: "failed",
          })
        ),
        session: {
          ...board.session,
          currentTaskId: undefined,
          errorMessage: event.error,
          state: "error",
        },
      };

    case "card.aborted": {
      const columns = withTaskUpdated(
        moveCard(board.columns, event.taskId, "done"),
        event.taskId,
        (task) => ({
          ...task,
          pendingApproval: undefined,
          pendingApprovals: [],
          errorMessage: undefined,
          outcome: "aborted",
        })
      );
      const releasesTask = board.session.currentTaskId === event.taskId;
      return {
        ...board,
        columns,
        session: releasesTask
          ? { ...board.session, currentTaskId: undefined }
          : board.session,
      };
    }

    case "run.started": {
      const columns = withTaskUpdated(board.columns, event.taskId, (task) => {
        const run = ensureRun(task, {
          model: event.model,
          sessionId: event.sessionId,
          startedAt: event.startedAt,
          taskTitle: event.taskTitle,
        });
        return {
          ...task,
          run: { ...run, elapsed: formatElapsed(run.startedAt ?? now, now) },
          runId: event.sessionId ?? task.runId,
        };
      });

      return {
        ...board,
        columns,
        session: {
          ...board.session,
          currentTaskId: event.taskId,
          errorMessage: undefined,
          sessionId: event.sessionId ?? board.session.sessionId,
          state: event.sessionId ? "active" : board.session.state,
        },
      };
    }

    case "step.upserted":
      return withRun(
        board,
        event.taskId,
        (run) => upsertStep(run, event.step, now),
        now
      );

    case "step.delta_appended":
      return withRun(
        board,
        event.taskId,
        (run) => appendDelta(run, event.stepId, event.delta, now),
        now
      );

    default:
      return unhandledBoardEvent(event, board);
  }
}
