import posthog from "posthog-js";
import { useCallback, useRef, useState } from "react";
import type { Columns, Task } from "@/features/kanban/components/kanban";
import {
  canRedoKanbanHistory,
  canUndoKanbanHistory,
  EMPTY_KANBAN_HISTORY,
  recordKanbanHistory,
  redoKanbanHistory,
  undoKanbanHistory,
} from "@/features/kanban/utils/kanban-history-state";

function extractPromptFromTask(task: Task): string {
  if (!task.run?.steps) {
    return task.title;
  }

  const submitStep = task.run.steps.find(
    (step) =>
      step.kind === "thinking" &&
      step.summary === "Submitting prompt to OpenCode"
  );

  return submitStep?.content ?? task.title;
}

export function useKanbanHistory() {
  const [history, setHistory] = useState(EMPTY_KANBAN_HISTORY);
  const historyRef = useRef(history);

  const commitHistory = useCallback((next: typeof history) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const recordMove = useCallback(
    (
      boardId: string,
      columnsBefore: Columns,
      columnsAfter: Columns,
      task: Task
    ) => {
      const prompt = extractPromptFromTask(task);
      const timestamp = Date.now();

      posthog.capture("kanban_history_record", {
        boardId,
        taskId: task.id,
        taskTitle: task.title,
        promptLength: prompt.length,
        timestamp,
      });

      commitHistory(
        recordKanbanHistory(historyRef.current, {
          boardId,
          columnsBefore,
          columnsAfter,
          prompt,
          task,
          timestamp,
        })
      );
    },
    [commitHistory]
  );

  const undo = useCallback(
    (
      boardId: string
    ): {
      columns: Columns;
      prompt: string;
      task: Task;
    } | null => {
      const current = historyRef.current;
      const transition = undoKanbanHistory(current, boardId);
      if (!transition) {
        posthog.capture("kanban_undo_empty", { boardId });
        return null;
      }

      const { entry } = transition;
      posthog.capture("kanban_undo", {
        boardId,
        taskId: entry.task.id,
        taskTitle: entry.task.title,
        promptLength: entry.prompt.length,
        stackDepth: current.undo.length,
      });
      commitHistory(transition.state);

      return {
        columns: entry.columnsBefore,
        prompt: entry.prompt,
        task: entry.task,
      };
    },
    [commitHistory]
  );

  const redo = useCallback(
    (
      boardId: string
    ): {
      columns: Columns;
      task: Task;
    } | null => {
      const current = historyRef.current;
      const transition = redoKanbanHistory(current, boardId);
      if (!transition) {
        posthog.capture("kanban_redo_empty", { boardId });
        return null;
      }

      const { entry } = transition;
      posthog.capture("kanban_redo", {
        boardId,
        taskId: entry.task.id,
        taskTitle: entry.task.title,
        stackDepth: current.redo.length,
      });
      commitHistory(transition.state);

      return {
        columns: entry.columnsAfter,
        task: entry.task,
      };
    },
    [commitHistory]
  );

  const clear = useCallback(() => {
    commitHistory(EMPTY_KANBAN_HISTORY);
  }, [commitHistory]);

  const canRedo = useCallback(
    (boardId: string) => canRedoKanbanHistory(history, boardId),
    [history]
  );
  const canUndo = useCallback(
    (boardId: string) => canUndoKanbanHistory(history, boardId),
    [history]
  );

  return {
    canRedo,
    canUndo,
    clear,
    recordMove,
    redo,
    undo,
  };
}
