"use client";

import {
  addEdge,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { KanbanCardNodeData } from "@/features/kanban/card-node/node-data";
import type {
  WorkspaceBoard,
  WorkspacePreferences,
} from "@/features/workspace/types";
import { computeBoardLayout, getAutoLayoutBoardIds } from "../lib/board-layout";
import { focusBoardOnCanvas } from "../lib/board-navigation";
import { reconcileNodes } from "../lib/kanban-nodes";
import type { CanvasFlowInstance } from "./use-canvas-viewport";

export function useCanvasGraph({
  boards,
  boardLayoutVersion,
  canvasSize,
  flowInstanceRef,
  handleRemoveBoard,
  positionOfBoard,
  preferences,
  removingBoardId,
  selectedBoardId,
  selectBoard,
  updateBoardPosition,
}: {
  boards: WorkspaceBoard[];
  boardLayoutVersion: number;
  canvasSize: { height: number; width: number };
  flowInstanceRef: { current: CanvasFlowInstance | null };
  handleRemoveBoard: (boardId: string) => Promise<void>;
  positionOfBoard: (board: WorkspaceBoard) => { x: number; y: number };
  preferences: WorkspacePreferences;
  removingBoardId: string | null;
  selectedBoardId: string | null;
  selectBoard: (boardId: string) => void;
  updateBoardPosition: (
    boardId: string,
    position: { x: number; y: number }
  ) => void;
}) {
  const [nodes, setNodes] = useState<Node<KanbanCardNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [fitViewToken, setFitViewToken] = useState(0);
  const previousBoardIdsRef = useRef<string[]>([]);
  const previousBoardLayoutVersionRef = useRef(0);
  const previousViewModeRef = useRef<
    WorkspacePreferences["boardViewMode"] | null
  >(null);
  const isNodeClickRef = useRef(false);
  const boardViewMode = preferences.boardViewMode;
  const selectedBoardNodeReady = nodes.some(
    (node) => node.id === selectedBoardId
  );

  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((current) => addEdge({ ...params, animated: true }, current)),
    []
  );

  const persistBoardPosition = useEffectEvent(
    (boardId: string, position: { x: number; y: number }) => {
      updateBoardPosition(boardId, position);
    }
  );

  useEffect(() => {
    if (canvasSize.width === 0) {
      return;
    }

    const forceReset =
      boardLayoutVersion !== previousBoardLayoutVersionRef.current;
    const autoLayoutBoardIds = getAutoLayoutBoardIds({
      boards,
      forceReset,
      previousBoardIds: previousBoardIdsRef.current,
      previousViewMode: previousViewModeRef.current,
      viewMode: boardViewMode,
    });

    previousBoardIdsRef.current = boards.map((board) => board.boardId);
    previousBoardLayoutVersionRef.current = boardLayoutVersion;
    previousViewModeRef.current = boardViewMode;
    if (autoLayoutBoardIds.length === 0) {
      return;
    }

    const layout = computeBoardLayout({
      boards,
      canvasWidth: canvasSize.width,
      selectedBoardId: null,
      viewMode: boardViewMode,
    });
    const autoLayoutBoardIdSet = new Set(autoLayoutBoardIds);
    let movedBoardCount = 0;

    for (const board of boards) {
      if (!autoLayoutBoardIdSet.has(board.boardId)) {
        continue;
      }
      const layoutItem = layout.get(board.boardId);
      if (
        !layoutItem ||
        (layoutItem.position.x === board.position.x &&
          layoutItem.position.y === board.position.y)
      ) {
        continue;
      }

      persistBoardPosition(board.boardId, layoutItem.position);
      movedBoardCount += 1;
    }

    if (movedBoardCount > 0) {
      setFitViewToken((current) => current + 1);
    }
  }, [boardViewMode, boardLayoutVersion, boards, canvasSize.width]);

  useEffect(() => {
    const layout = computeBoardLayout({
      boards,
      canvasWidth: canvasSize.width,
      selectedBoardId,
      viewMode: boardViewMode,
    });

    startTransition(() => {
      setNodes((current) =>
        reconcileNodes(
          current,
          boards,
          layout,
          selectedBoardId,
          handleRemoveBoard,
          removingBoardId,
          positionOfBoard
        )
      );
    });
  }, [
    boardViewMode,
    boards,
    canvasSize.width,
    handleRemoveBoard,
    positionOfBoard,
    removingBoardId,
    selectedBoardId,
  ]);

  useEffect(() => {
    const boardIds = new Set(boards.map((board) => board.boardId));
    setEdges((current) => {
      const retained = current.filter(
        (edge) => boardIds.has(edge.source) && boardIds.has(edge.target)
      );
      return retained.length === current.length ? current : retained;
    });
  }, [boards]);

  useEffect(() => {
    if (fitViewToken === 0 || nodes.length === 0) {
      return;
    }

    let nestedAnimationFrameId = 0;
    const animationFrameId = window.requestAnimationFrame(() => {
      nestedAnimationFrameId = window.requestAnimationFrame(() => {
        flowInstanceRef.current?.fitView({
          duration: 720,
          padding: boardViewMode === "stacked" ? 0.18 : 0.12,
        });
      });
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.cancelAnimationFrame(nestedAnimationFrameId);
    };
  }, [boardViewMode, fitViewToken, flowInstanceRef, nodes.length]);

  useEffect(() => {
    if (isNodeClickRef.current) {
      isNodeClickRef.current = false;
      return;
    }

    const instance = flowInstanceRef.current;
    if (!(instance && selectedBoardId && selectedBoardNodeReady)) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      focusBoardOnCanvas(instance, selectedBoardId);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [flowInstanceRef, selectedBoardId, selectedBoardNodeReady]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      isNodeClickRef.current = true;
      selectBoard(nodeId);
    },
    [selectBoard]
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<KanbanCardNodeData>>[]) => {
      setNodes(
        (current) =>
          applyNodeChanges(changes, current) as Node<KanbanCardNodeData>[]
      );
    },
    []
  );

  const handleInit = useCallback(
    (instance: CanvasFlowInstance) => {
      flowInstanceRef.current = instance;
      if (selectedBoardId) {
        window.requestAnimationFrame(() => {
          focusBoardOnCanvas(instance, selectedBoardId);
        });
      }
    },
    [flowInstanceRef, selectedBoardId]
  );

  return {
    edges,
    onConnect,
    onNodeClick: handleNodeClick,
    onNodesChange: handleNodesChange,
    onInit: handleInit,
    nodes,
  };
}
