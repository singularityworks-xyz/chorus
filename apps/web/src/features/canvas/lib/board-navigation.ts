import { BOARD_CARD_HEIGHT, BOARD_CARD_WIDTH } from "./board-layout";

interface BoardViewportController {
  getNode: (boardId: string) =>
    | {
        position: { x: number; y: number };
      }
    | undefined;
  setCenter: (
    x: number,
    y: number,
    options: { duration: number; zoom: number }
  ) => unknown;
}

/** Move the canvas to the selected board when that node is available. */
export function focusBoardOnCanvas(
  instance: BoardViewportController,
  boardId: string | null
): boolean {
  if (!boardId) {
    return false;
  }

  const node = instance.getNode(boardId);
  if (!node) {
    return false;
  }

  instance.setCenter(
    node.position.x + BOARD_CARD_WIDTH / 2,
    node.position.y + BOARD_CARD_HEIGHT / 2,
    { duration: 300, zoom: 1 }
  );
  return true;
}
