"use client";

import type { Columns } from "@chorus/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  hasObservedTaskCommand,
  isBoardTaskCommandBusy,
} from "../utils/board-task-state";
import { shouldClearAwaitingTaskAction } from "../utils/task-approval-state";
import type { KanbanTaskActionState, SetTaskActionState } from "./types";

const TASK_COMMAND_EVENT_TIMEOUT_MS = 20_000;
const TASK_COMMAND_EVENT_TIMEOUT_MESSAGE =
  "The request was accepted, but the board has not confirmed it yet. Refresh the board to check its status before trying again.";

export function useTaskActionState(
  eventColumns: Columns,
  commandColumns: Columns = eventColumns
) {
  const [actionStates, setActionStates] = useState<
    Record<string, KanbanTaskActionState | undefined>
  >({});
  const inFlightTaskActionRef = useRef(new Set<string>());
  const inFlightBoardTaskCommandRef = useRef(false);
  const boardBusy = isBoardTaskCommandBusy(commandColumns, actionStates);

  const setTaskActionState = useCallback<SetTaskActionState>(
    (taskId, state) => {
      setActionStates((current) => ({ ...current, [taskId]: state }));
    },
    []
  );

  useEffect(() => {
    const approvalTasks = new Map(
      (eventColumns.approve ?? []).map((task) => [task.id, task])
    );
    const taskIdsToClear = Object.entries(actionStates)
      .filter(
        ([taskId, state]) =>
          state?.awaitingEvent &&
          shouldClearAwaitingTaskAction(approvalTasks.get(taskId), state)
      )
      .map(([taskId]) => taskId);
    if (taskIdsToClear.length === 0) {
      return;
    }

    setActionStates((current) => {
      const next = { ...current };
      for (const taskId of taskIdsToClear) {
        if (next[taskId]?.awaitingEvent) {
          delete next[taskId];
        }
      }
      return next;
    });
  }, [actionStates, eventColumns]);

  useEffect(() => {
    const taskIdsToClear = Object.entries(actionStates)
      .filter(
        ([, state]) =>
          state?.awaitingTaskCommandId &&
          hasObservedTaskCommand(state.awaitingTaskCommandId, eventColumns)
      )
      .map(([taskId]) => taskId);
    if (taskIdsToClear.length === 0) {
      return;
    }

    setActionStates((current) => {
      const next = { ...current };
      for (const taskId of taskIdsToClear) {
        if (next[taskId]?.awaitingTaskCommandId) {
          delete next[taskId];
        }
      }
      return next;
    });
  }, [actionStates, eventColumns]);

  useEffect(() => {
    const waitingCommands = Object.entries(actionStates).flatMap(
      ([taskId, state]) =>
        state?.awaitingTaskCommandId && state.awaitingTaskCommandStartedAt
          ? [
              {
                taskId,
                commandId: state.awaitingTaskCommandId,
                startedAt: state.awaitingTaskCommandStartedAt,
              },
            ]
          : []
    );
    if (waitingCommands.length === 0) {
      return;
    }

    const timers = waitingCommands.map(({ taskId, commandId, startedAt }) =>
      setTimeout(
        () => {
          setActionStates((current) => {
            const state = current[taskId];
            if (
              state?.awaitingTaskCommandId !== commandId ||
              state.awaitingTaskCommandStartedAt !== startedAt
            ) {
              return current;
            }
            return {
              ...current,
              [taskId]: {
                awaitingTaskCommandId: commandId,
                awaitingTaskCommandTimedOut: true,
                error: TASK_COMMAND_EVENT_TIMEOUT_MESSAGE,
              },
            };
          });
        },
        Math.max(0, startedAt + TASK_COMMAND_EVENT_TIMEOUT_MS - Date.now())
      )
    );

    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [actionStates]);

  return {
    actionStates,
    boardBusy,
    inFlightBoardTaskCommandRef,
    inFlightTaskActionRef,
    setTaskActionState,
  };
}
