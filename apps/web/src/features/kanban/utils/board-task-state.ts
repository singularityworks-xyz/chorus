import type { Columns } from "@chorus/contracts";

interface BoardTaskActionState {
  awaitingTaskCommandId?: string;
  awaitingTaskCommandTimedOut?: boolean;
  pending?: string;
}

export type BoardTaskCommand = "run" | "retry";

interface BoardTaskCommandButtonState {
  disabled: boolean;
  label: string;
  title: string;
}

export function hasLiveBoardTask(columns: Columns): boolean {
  return (
    Boolean(columns.in_progress?.length) ||
    (columns.approve ?? []).some((task) => task.outcome === "awaiting_review")
  );
}

export function isBoardTaskCommandBusy(
  columns: Columns,
  actionStates: Readonly<Record<string, BoardTaskActionState | undefined>>
): boolean {
  return (
    hasLiveBoardTask(columns) ||
    Object.values(actionStates).some(
      (state) =>
        Boolean(state?.pending) ||
        Boolean(
          state?.awaitingTaskCommandId && !state.awaitingTaskCommandTimedOut
        )
    )
  );
}

export function hasObservedTaskCommand(
  taskId: string,
  columns: Columns
): boolean {
  return [
    ...(columns.in_progress ?? []),
    ...(columns.approve ?? []),
    ...(columns.done ?? []),
  ].some((task) => task.id === taskId);
}

export function getBoardTaskCommandButtonState(
  action: BoardTaskCommand,
  actionState: BoardTaskActionState | undefined,
  boardBusy: boolean,
  hasSavedPrompt: boolean
): BoardTaskCommandButtonState {
  let title = action === "run" ? "Run task" : "Retry task";
  if (!hasSavedPrompt) {
    title = "The saved prompt is unavailable";
  } else if (boardBusy) {
    title =
      action === "run"
        ? "Finish or resolve current work before starting another task"
        : "Finish or resolve current work before retrying another task";
  }

  const isAwaitingBoard =
    Boolean(actionState?.awaitingTaskCommandId) &&
    !actionState?.awaitingTaskCommandTimedOut;
  let label = action === "run" ? "Run" : "Retry";
  if (actionState?.pending === action) {
    label = action === "run" ? "Starting…" : "Retrying…";
  } else if (isAwaitingBoard) {
    label = "Waiting…";
  }

  return {
    disabled: Boolean(actionState?.pending) || boardBusy || !hasSavedPrompt,
    label,
    title,
  };
}
