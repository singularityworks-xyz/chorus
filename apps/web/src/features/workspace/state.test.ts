import { describe, expect, test } from "bun:test";
import { isCurrentBoardSelection } from "./state";

describe("board selection persistence", () => {
  test("identifies a click on the already selected board as a no-op", () => {
    expect(isCurrentBoardSelection("board-1", "board-1")).toBe(true);
  });

  test("persists a different or initially selected board", () => {
    expect(isCurrentBoardSelection("board-1", "board-2")).toBe(false);
    expect(isCurrentBoardSelection(null, "board-1")).toBe(false);
  });
});
