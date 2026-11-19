"use client";

import type { Columns, Task } from "@chorus/contracts";
import { useCallback } from "react";
import {
  type BoardTaskAction,
  requestBoardTaskCommand,
} from "../task-command-client";
import { isBoardTaskCommandBusy } from "../utils/board-task-state";
import { taskActionErrorMessage } from "./errors";
import type { KanbanTaskActionState, SetTaskActionState } from "./types";

export function useBoardTaskCommands({
  actionStates,
  boardId,
  columns,
  inFlightBoardTaskCommandRef,
  inFlightTaskActionRef,
  setTaskActionState,
}: {
  actionStates: Record<string, KanbanTaskActionState | undefined>;
  boardId: string;
  columns: Columns;
  inFlightBoardTaskCommandRef: { current: boolean };
  inFlightTaskActionRef: { current: Set<string> };
  setTaskActionState: SetTaskActionState;
}) {
  const runTaskCommand = useCallback(
    async (taskId: string, action: BoardTaskAction) => {
      const task = Object.values(columns)
        .flat()
        .find((candidate: Task) => candidate.id === taskId);
      if (!task?.promptInput) {
        setTaskActionState(taskId, {
          error:
            "This task does not have a saved prompt, so it cannot be started again.",
        });
        return;
      }

      if (inFlightTaskActionRef.current.has(taskId)) {
        return;
      }
      if (
        inFlightBoardTaskCommandRef.current ||
        isBoardTaskCommandBusy(columns, actionStates)
      ) {
        return;
      }
      inFlightTaskActionRef.current.add(taskId);
      inFlightBoardTaskCommandRef.current = true;
      setTaskActionState(taskId, { pending: action });
      try {
        const command = await requestBoardTaskCommand(boardId, taskId, action);
        setTaskActionState(taskId, {
          awaitingTaskCommandId: command.taskId,
          awaitingTaskCommandStartedAt: Date.now(),
          message:
            command.status === "already_running"
              ? "This task is already running. Waiting for the board to update…"
              : "Request accepted. Waiting for the board to update…",
        });
      } catch (error) {
        const message = taskActionErrorMessage(
          error,
          `Could not ${action} this task. Try again.`
        );
        setTaskActionState(taskId, { error: message });
      } finally {
        inFlightTaskActionRef.current.delete(taskId);
        inFlightBoardTaskCommandRef.current = false;
      }
    },
    [
      actionStates,
      boardId,
      columns,
      inFlightBoardTaskCommandRef,
      inFlightTaskActionRef,
      setTaskActionState,
    ]
  );

  const handleRun = useCallback(
    (taskId: string) => runTaskCommand(taskId, "run"),
    [runTaskCommand]
  );
  const handleRetry = useCallback(
    (taskId: string) => runTaskCommand(taskId, "retry"),
    [runTaskCommand]
  );

  return { handleRetry, handleRun };
}
