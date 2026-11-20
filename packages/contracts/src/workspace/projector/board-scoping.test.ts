import { describe, expect, test } from "bun:test";
import { workspaceBoardSchema } from "../base/boards";
import { applyEventToBoard, applyEventToBoards } from "../projector";
import { BOARD, makeBoard, T0 } from "./test-support";

describe("board scoping", () => {
  test("ignores an event addressed to a different board", () => {
    const board = makeBoard();
    const next = applyEventToBoard(board, {
      type: "board.moved",
      ts: T0,
      boardId: "board-other",
      position: { x: 99, y: 99 },
    });

    expect(next).toBe(board);
  });

  test("ignores workspace-scoped events", () => {
    const board = makeBoard();
    expect(
      applyEventToBoard(board, {
        type: "preference.speech_voice_set",
        ts: T0,
        voiceId: "hannah",
      })
    ).toBe(board);

    expect(
      applyEventToBoard(board, {
        type: "board.selected",
        ts: T0,
        boardId: BOARD,
      })
    ).toBe(board);
  });

  test("applyEventToBoards only replaces the addressed board", () => {
    const other = workspaceBoardSchema.parse({
      ...makeBoard(),
      boardId: "board-2",
    });
    const boards = [makeBoard(), other];

    const next = applyEventToBoards(boards, {
      type: "board.moved",
      ts: T0,
      boardId: BOARD,
      position: { x: 42, y: 42 },
    });

    expect(next[0].position).toEqual({ x: 42, y: 42 });
    expect(next[1]).toBe(other);
  });

  test("applyEventToBoards returns the same array when nothing changed", () => {
    const boards = [makeBoard()];
    expect(
      applyEventToBoards(boards, {
        type: "board.moved",
        ts: T0,
        boardId: "nobody",
        position: { x: 1, y: 1 },
      })
    ).toBe(boards);
  });
});
