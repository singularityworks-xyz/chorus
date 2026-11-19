import { describe, expect, test } from "bun:test";
import { BOARD_CARD_HEIGHT, BOARD_CARD_WIDTH } from "./board-layout";
import { focusBoardOnCanvas } from "./board-navigation";

describe("focusBoardOnCanvas", () => {
  test("centers the selected board at the standard canvas zoom", () => {
    const calls: unknown[][] = [];
    const instance = {
      getNode: (boardId: string) =>
        boardId === "board-7" ? { position: { x: 1448, y: 1656 } } : undefined,
      setCenter: (...args: unknown[]) => {
        calls.push(args);
      },
    };

    expect(focusBoardOnCanvas(instance, "board-7")).toBe(true);
    expect(calls).toEqual([
      [
        1448 + BOARD_CARD_WIDTH / 2,
        1656 + BOARD_CARD_HEIGHT / 2,
        { duration: 300, zoom: 1 },
      ],
    ]);
  });

  test("does not move the viewport without a selected and loaded board", () => {
    const calls: unknown[][] = [];
    const instance = {
      getNode: () => undefined,
      setCenter: (...args: unknown[]) => {
        calls.push(args);
      },
    };

    expect(focusBoardOnCanvas(instance, null)).toBe(false);
    expect(focusBoardOnCanvas(instance, "missing-board")).toBe(false);
    expect(calls).toEqual([]);
  });
});
