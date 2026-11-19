import { expect, test } from "bun:test";
import { notificationFocusDecision } from "./notification-focus-state";

test("notification focus waits for the live snapshot before checking a board", () => {
  const input = {
    boardId: "board-1",
    boards: [],
    cardId: "task-1",
    sessionStatus: "connecting" as const,
  };

  expect(notificationFocusDecision(input)).toEqual({ state: "wait" });
  expect(
    notificationFocusDecision({
      ...input,
      boards: [{ boardId: "board-1" }],
      sessionStatus: "live",
    })
  ).toEqual({ boardId: "board-1", cardId: "task-1", state: "focus" });
});

test("notification focus reports a missing board after the live snapshot", () => {
  expect(
    notificationFocusDecision({
      boardId: "missing-board",
      boards: [],
      cardId: "task-1",
      sessionStatus: "live",
    })
  ).toEqual({ state: "unavailable" });
});
