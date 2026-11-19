"use client";

import {
  addEdge,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  type CoordinateExtent,
  type Edge,
  type Node,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { KeyboardIcon, XIcon } from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  computeBoardLayout,
  getAutoLayoutBoardIds,
} from "@/features/canvas/lib/board-layout";
import { focusBoardOnCanvas } from "@/features/canvas/lib/board-navigation";
import { hasCanvasViewport } from "@/features/canvas/lib/canvas-viewport";
import { KanbanCardNode } from "@/features/kanban/card-node/kanban-card-node";
import {
  KANBAN_CARD_NODE_TYPE,
  type KanbanCardNodeData,
} from "@/features/kanban/card-node/node-data";
import { displayedPosition } from "@/features/workspace/reducer";
import type {
  WorkspaceBoard,
  WorkspacePreferences,
} from "@/features/workspace/types";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { reconcileNodes } from "../lib/kanban-nodes";
import { CanvasControls } from "./canvas-controls";
import {
  CANVAS_DEFAULT_VIEWPORT,
  KeyboardHelpPanel,
  KeyboardShortcuts,
} from "./keyboard-shortcuts";

const WORLD_EXTENT: CoordinateExtent = [
  [-2_000_000, -2_000_000],
  [2_000_000, 2_000_000],
];

const nodeTypes = {
  [KANBAN_CARD_NODE_TYPE]: KanbanCardNode,
};
export function BackgroundCanvas() {
  const {
    boards,
    pendingDrags,
    boardLayoutVersion,
    clearSelection,
    focusBoardLocally,
    preferences,
    removeBoard,
    selectedBoardId,
    selectBoard,
    updateBoardPosition,
  } = useWorkspace();
  const [nodes, setNodes] = useState<Node<KanbanCardNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [fitViewToken, setFitViewToken] = useState(0);
  const [removingBoardId, setRemovingBoardId] = useState<string | null>(null);
  const [boardRemovalError, setBoardRemovalError] = useState<string | null>(
    null
  );
  const [canvasSize, setCanvasSize] = useState({
    height: 0,
    width: 0,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const rfInstanceRef = useRef<ReactFlowInstance<
    Node<KanbanCardNodeData>,
    Edge
  > | null>(null);
  const previousBoardIdsRef = useRef<string[]>([]);
  const previousBoardLayoutVersionRef = useRef(0);
  const previousViewModeRef = useRef<
    WorkspacePreferences["boardViewMode"] | null
  >(null);
  const isNodeClickRef = useRef(false);
  const removeInFlightRef = useRef(false);
  const hasMeasuredCanvasViewport = hasCanvasViewport(
    canvasSize.width,
    canvasSize.height
  );
  const selectedBoardNodeReady = nodes.some(
    (node) => node.id === selectedBoardId
  );

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    // Let scrollable task content handle its own wheel events.
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".nowheel")
    ) {
      return;
    }

    event.preventDefault();

    const rf = rfInstanceRef.current;
    if (!rf) {
      return;
    }

    const current = rf.getViewport();

    if (event.ctrlKey || event.metaKey) {
      const zoomFactor = 0.002;
      const newZoom = Math.max(
        0.15,
        Math.min(4, current.zoom * (1 - event.deltaY * zoomFactor))
      );
      rf.setViewport({ x: current.x, y: current.y, zoom: newZoom });
    } else {
      const panFactor = 1.2;
      const dx = event.shiftKey
        ? -event.deltaY * panFactor
        : -event.deltaX * panFactor;
      const dy = event.shiftKey ? 0 : -event.deltaY * panFactor;

      rf.setViewport({
        x: current.x + dx,
        y: current.y + dy,
        zoom: current.zoom,
      });
    }
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width);
      const nextHeight = Math.round(entry.contentRect.height);

      setCanvasSize((currentSize) => {
        if (
          currentSize.width === nextWidth &&
          currentSize.height === nextHeight
        ) {
          return currentSize;
        }

        return {
          height: nextHeight,
          width: nextWidth,
        };
      });
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  // Recheck drag deadlines during render because time passing does not update state.
  const positionOfBoard = useCallback(
    (board: WorkspaceBoard) =>
      displayedPosition(board, pendingDrags, Date.now()),
    [pendingDrags]
  );

  useEffect(() => {
    if (
      !removingBoardId ||
      boards.some((board) => board.boardId === removingBoardId)
    ) {
      return;
    }

    removeInFlightRef.current = false;
    setRemovingBoardId(null);
  }, [boards, removingBoardId]);

  const handleRemoveBoard = useCallback(
    async (boardId: string) => {
      if (removeInFlightRef.current) {
        return;
      }

      removeInFlightRef.current = true;
      setRemovingBoardId(boardId);
      setBoardRemovalError(null);
      try {
        await removeBoard(boardId);
      } catch {
        removeInFlightRef.current = false;
        setRemovingBoardId(null);
        setBoardRemovalError(
          "Could not remove this board. It remains open; try again."
        );
      }
    },
    [removeBoard]
  );

  const handleRemoveSelected = useCallback(() => {
    if (selectedBoardId) {
      return handleRemoveBoard(selectedBoardId);
    }
  }, [handleRemoveBoard, selectedBoardId]);

  const handleNewTask = useCallback(() => {
    if (!selectedBoardId) {
      return;
    }
    focusBoardLocally(selectedBoardId);
    window.requestAnimationFrame(() => {
      document.getElementById("chorus-prompt-input")?.focus();
    });
  }, [focusBoardLocally, selectedBoardId]);

  const handleToggleHelp = useCallback(() => {
    setShowHelp((v) => !v);
  }, []);

  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    []
  );
  const boardViewMode = preferences.boardViewMode;
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
      setFitViewToken((currentToken) => currentToken + 1);
    }
  }, [boardLayoutVersion, boardViewMode, boards, canvasSize.width]);

  useEffect(() => {
    const layout = computeBoardLayout({
      boards,
      canvasWidth: canvasSize.width,
      selectedBoardId,
      viewMode: boardViewMode,
    });

    startTransition(() => {
      setNodes((currentNodes) =>
        reconcileNodes(
          currentNodes,
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
    setEdges((currentEdges) => {
      const retainedEdges = currentEdges.filter(
        (edge) => boardIds.has(edge.source) && boardIds.has(edge.target)
      );
      return retainedEdges.length === currentEdges.length
        ? currentEdges
        : retainedEdges;
    });
  }, [boards]);

  useEffect(() => {
    if (fitViewToken === 0 || nodes.length === 0) {
      return;
    }

    let nestedAnimationFrameId = 0;
    const animationFrameId = window.requestAnimationFrame(() => {
      nestedAnimationFrameId = window.requestAnimationFrame(() => {
        rfInstanceRef.current?.fitView({
          duration: 720,
          padding: boardViewMode === "stacked" ? 0.18 : 0.12,
        });
      });
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.cancelAnimationFrame(nestedAnimationFrameId);
    };
  }, [boardViewMode, fitViewToken, nodes.length]);

  // Retry focus when the selected board node appears after workspace hydration.
  useEffect(() => {
    if (isNodeClickRef.current) {
      isNodeClickRef.current = false;
      return;
    }

    const instance = rfInstanceRef.current;
    if (!(instance && selectedBoardId && selectedBoardNodeReady)) {
      return;
    }

    let frameId = 0;
    frameId = window.requestAnimationFrame(() => {
      focusBoardOnCanvas(instance, selectedBoardId);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [selectedBoardId, selectedBoardNodeReady]);

  return (
    <div className="h-full w-full" ref={containerRef}>
      {/* Wait for a measured viewport before mounting React Flow in the hidden mobile layout. */}
      {isMounted && hasMeasuredCanvasViewport ? (
        <ReactFlow
          className="background-flow dark"
          defaultViewport={CANVAS_DEFAULT_VIEWPORT}
          deleteKeyCode={null}
          edges={edges}
          edgesFocusable={true}
          elementsSelectable={true}
          maxZoom={4}
          minZoom={0.15}
          nodeExtent={WORLD_EXTENT}
          nodes={nodes}
          nodesConnectable={true}
          nodesDraggable={true}
          nodesFocusable={true}
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          onInit={(instance) => {
            rfInstanceRef.current = instance;
            if (selectedBoardId) {
              window.requestAnimationFrame(() => {
                focusBoardOnCanvas(instance, selectedBoardId);
              });
            }
          }}
          onlyRenderVisibleElements
          onNodeClick={(_, node) => {
            isNodeClickRef.current = true;
            selectBoard(node.id);
          }}
          onNodeDragStop={(_, node) => {
            updateBoardPosition(node.id, node.position);
          }}
          onNodesChange={(changes) => {
            setNodes(
              (currentNodes) =>
                applyNodeChanges(
                  changes,
                  currentNodes
                ) as Node<KanbanCardNodeData>[]
            );
          }}
          onPaneClick={clearSelection}
          panOnDrag
          panOnScroll={false}
          selectNodesOnDrag={true}
          translateExtent={WORLD_EXTENT}
          zoomOnDoubleClick={false}
          zoomOnPinch
          zoomOnScroll={false}
        >
          <KeyboardShortcuts
            onNewTask={handleNewTask}
            onRemoveSelected={handleRemoveSelected}
            onToggleHelp={handleToggleHelp}
          />

          {boardRemovalError && (
            <Panel className="!left-4 !top-4" position="top-left">
              <div
                className="flex max-w-md items-start gap-3 rounded-sm border border-rose-500/25 bg-[#180d0d]/95 px-3 py-2.5 text-rose-200 text-xs shadow-xl"
                role="alert"
              >
                <span className="flex-1">{boardRemovalError}</span>
                <button
                  aria-label="Dismiss board removal error"
                  className="rounded-xs p-0.5 text-rose-200/60 hover:bg-white/10 hover:text-rose-100"
                  onClick={() => setBoardRemovalError(null)}
                  type="button"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            </Panel>
          )}

          <CanvasControls />
          <Background
            bgColor="#0a0a0a"
            color="rgba(255, 255, 255, 0.4)"
            gap={26}
            size={1.8}
            variant={BackgroundVariant.Dots}
          />
        </ReactFlow>
      ) : null}

      {/* Portal the shortcut panel above the page layout. */}
      {isMounted &&
        createPortal(
          <div className="fixed right-4 bottom-8 z-9999 hidden flex-col items-end gap-2 sm:flex">
            {showHelp && (
              <KeyboardHelpPanel onClose={() => setShowHelp(false)} />
            )}
            <button
              aria-label="Keyboard shortcuts"
              className={[
                "flex size-11 items-center justify-center rounded-sm border transition-all duration-150",
                "shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-xl",
                showHelp
                  ? "border-white/20 bg-white/15 text-white/80"
                  : "border-white/10 bg-[#0f0f0f]/90 text-white/35 hover:border-white/15 hover:bg-white/10 hover:text-white/60",
              ].join(" ")}
              onClick={handleToggleHelp}
              title="Keyboard shortcuts (?)"
              type="button"
            >
              <KeyboardIcon className="size-4" />
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
