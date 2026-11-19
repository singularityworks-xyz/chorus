import { describe, expect, test } from "bun:test";
import { isBoardScopedEvent } from "../events";
import { EVENT_CORPUS, TS } from "./test-support";

describe("board scoping", () => {
  test("board-scoped events report a boardId", () => {
    expect(isBoardScopedEvent(EVENT_CORPUS["board.moved"])).toBe(true);
    expect(isBoardScopedEvent(EVENT_CORPUS["card.started"])).toBe(true);
  });

  test("preference events are not board scoped", () => {
    expect(
      isBoardScopedEvent(EVENT_CORPUS["preference.speech_voice_set"])
    ).toBe(false);
  });

  test("deselecting is workspace scoped even though it names a board", () => {
    expect(
      isBoardScopedEvent({ type: "board.selected", ts: TS, boardId: null })
    ).toBe(false);
  });
});
