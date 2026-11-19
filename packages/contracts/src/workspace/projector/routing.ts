import type { WorkspaceBoard } from "../base/boards";
import type { BoardScopedEvent } from "../events";

export type SessionScopedEvent = Extract<
  BoardScopedEvent,
  { type: `session.${string}` }
>;

export type CardRunStepEvent = Extract<
  BoardScopedEvent,
  { type: `card.${string}` | `run.${string}` | `step.${string}` }
>;

export type BoardLifecycleEvent = Extract<
  BoardScopedEvent,
  { type: `board.${string}` }
>;

export function isSessionScopedEvent(
  event: BoardScopedEvent
): event is SessionScopedEvent {
  return event.type.startsWith("session.");
}

export function isCardRunStepEvent(
  event: BoardScopedEvent
): event is CardRunStepEvent {
  return (
    event.type.startsWith("card.") ||
    event.type.startsWith("run.") ||
    event.type.startsWith("step.")
  );
}

export function resolveTaskId(
  event: BoardScopedEvent,
  board: WorkspaceBoard
): string | null {
  if ("taskId" in event && typeof event.taskId === "string") {
    return event.taskId;
  }
  return board.session.currentTaskId ?? null;
}

// Makes each board-event switch fail to compile when a new variant is unhandled.
export function unhandledBoardEvent(
  _event: never,
  board: WorkspaceBoard
): WorkspaceBoard {
  return board;
}
