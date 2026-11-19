import { describe, expect, test } from "bun:test";
import type { WorkspaceBoard } from "@chorus/contracts";
import { computeBoardLayout } from "./board-layout";
import { createKanbanCardNode, reconcileNodes } from "./kanban-nodes";

function makeBoard(title = "Board"): WorkspaceBoard {
  return {
    boardId: "board-1",
    columns: {},
    modelSelection: null,
    position: { x: 10, y: 20 },
    repo: { directory: "/repo", worktree: "/repo", sandboxes: [] },
    reviewMode: "auto",
    session: { state: "uninitialized" },
    title,
  };
}

function layoutFor(board: WorkspaceBoard) {
  return computeBoardLayout({
    boards: [board],
    canvasWidth: 1600,
    selectedBoardId: board.boardId,
    viewMode: "relaxed",
  });
}

describe("kanban canvas nodes", () => {
  test("builds a node from board state and the supplied optimistic position", () => {
    const board = makeBoard();
    const onRemove = () => undefined;
    const position = { x: 40, y: 60 };
    const node = createKanbanCardNode(
      board,
      layoutFor(board),
      true,
      onRemove,
      board.boardId,
      position
    );

    expect(node.position).toEqual(position);
    expect(node.selected).toBe(true);
    expect(node.data.isRemoving).toBe(true);
    expect(node.data.onRemove).toBe(onRemove);
    expect(node.data.title).toBe(board.title);
  });

  test("updates board data while preserving React Flow's current node state", () => {
    const board = makeBoard();
    const current = createKanbanCardNode(
      board,
      layoutFor(board),
      false,
      () => undefined,
      null,
      board.position
    );
    const nextBoard = makeBoard("Updated board");
    const nextPosition = { x: 80, y: 120 };
    const reconciled = reconcileNodes(
      [
        {
          ...current,
          dragging: true,
          data: { ...current.data, preserved: "value" },
        },
      ],
      [nextBoard],
      layoutFor(nextBoard),
      nextBoard.boardId,
      () => undefined,
      null,
      () => nextPosition
    );

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      dragging: true,
      position: nextPosition,
      selected: true,
      data: { preserved: "value", title: "Updated board" },
    });
  });
});
