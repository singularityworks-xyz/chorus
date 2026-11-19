import type { Node } from "@xyflow/react";
import type { KanbanCardNodeData } from "@/features/kanban/card-node/node-data";
import { KANBAN_CARD_NODE_TYPE } from "@/features/kanban/card-node/node-data";
import type { WorkspaceBoard } from "@/features/workspace/types";
import {
  BOARD_CARD_HEIGHT,
  BOARD_CARD_WIDTH,
  type computeBoardLayout,
} from "./board-layout";

const AUTO_LAYOUT_NODE_CLASS =
  "transition-[transform,width,height] duration-[560ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

export function createKanbanCardNode(
  board: WorkspaceBoard,
  layout: ReturnType<typeof computeBoardLayout>,
  selected: boolean,
  onRemove: (id: string) => void,
  removingBoardId: string | null,
  // Keep the optimistic position until the server confirms the move.
  position: { x: number; y: number }
): Node<KanbanCardNodeData> {
  const layoutItem = layout.get(board.boardId);

  return {
    id: board.boardId,
    className: AUTO_LAYOUT_NODE_CLASS,
    type: KANBAN_CARD_NODE_TYPE,
    position,
    data: {
      boardId: board.boardId,
      title: board.title,
      columns: board.columns,
      filePath: board.repo.directory,
      gitBranch: board.repo.branch,
      projectName: board.repo.projectName,
      reviewMode: board.reviewMode ?? "auto",
      sessionId: board.session.sessionId,
      sessionState: board.session.state,
      isRemoving: board.boardId === removingBoardId,
      onRemove,
    },
    selected,
    draggable: true,
    selectable: true,
    style: {
      height: layoutItem?.height ?? BOARD_CARD_HEIGHT,
      transitionProperty: "width, height",
      width: layoutItem?.width ?? BOARD_CARD_WIDTH,
      willChange: "transform, width, height",
    },
    zIndex: layoutItem?.zIndex ?? 0,
  };
}

export function reconcileNodes(
  currentNodes: Node<KanbanCardNodeData>[],
  boards: WorkspaceBoard[],
  layout: ReturnType<typeof computeBoardLayout>,
  selectedBoardId: string | null,
  onRemove: (id: string) => void,
  removingBoardId: string | null,
  positionOf: (board: WorkspaceBoard) => { x: number; y: number }
): Node<KanbanCardNodeData>[] {
  const currentNodesById = new Map(currentNodes.map((node) => [node.id, node]));

  return boards.map((board) => {
    const nextNode = createKanbanCardNode(
      board,
      layout,
      board.boardId === selectedBoardId,
      onRemove,
      removingBoardId,
      positionOf(board)
    );
    const currentNode = currentNodesById.get(board.boardId);

    if (!currentNode) {
      return nextNode;
    }

    return {
      ...currentNode,
      className: nextNode.className,
      draggable: nextNode.draggable,
      position: nextNode.position,
      selected: board.boardId === selectedBoardId,
      style: nextNode.style,
      zIndex: nextNode.zIndex,
      data: {
        ...currentNode.data,
        ...nextNode.data,
      },
    };
  });
}
