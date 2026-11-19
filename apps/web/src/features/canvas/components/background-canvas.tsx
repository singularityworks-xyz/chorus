"use client";

import {
  Background,
  BackgroundVariant,
  type CoordinateExtent,
  type Node,
  Panel,
  ReactFlow,
} from "@xyflow/react";
import { KeyboardIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useBoardRemoval } from "@/features/canvas/hooks/use-board-removal";
import { useCanvasGraph } from "@/features/canvas/hooks/use-canvas-graph";
import { useCanvasViewport } from "@/features/canvas/hooks/use-canvas-viewport";
import { KanbanCardNode } from "@/features/kanban/card-node/kanban-card-node";
import {
  KANBAN_CARD_NODE_TYPE,
  type KanbanCardNodeData,
} from "@/features/kanban/card-node/node-data";
import { displayedPosition } from "@/features/workspace/reducer";
import type { WorkspaceBoard } from "@/features/workspace/types";
import { useWorkspace } from "@/features/workspace/workspace-context";
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
    boardLayoutVersion,
    boards,
    clearSelection,
    focusBoardLocally,
    pendingDrags,
    preferences,
    removeBoard,
    selectedBoardId,
    selectBoard,
    updateBoardPosition,
  } = useWorkspace();
  const [showHelp, setShowHelp] = useState(false);
  const {
    canvasSize,
    containerRef,
    flowInstanceRef,
    hasMeasuredCanvasViewport,
    isMounted,
  } = useCanvasViewport();
  const positionOfBoard = useCallback(
    (board: WorkspaceBoard) =>
      displayedPosition(board, pendingDrags, Date.now()),
    [pendingDrags]
  );
  const {
    dismissError,
    error: boardRemovalError,
    remove: handleRemoveBoard,
    removeSelected: handleRemoveSelected,
    removingBoardId,
  } = useBoardRemoval({ boards, removeBoard, selectedBoardId });
  const graph = useCanvasGraph({
    boardLayoutVersion,
    boards,
    canvasSize,
    flowInstanceRef,
    handleRemoveBoard,
    positionOfBoard,
    preferences,
    removingBoardId,
    selectedBoardId,
    selectBoard,
    updateBoardPosition,
  });

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
    setShowHelp((visible) => !visible);
  }, []);

  return (
    <div className="h-full w-full" ref={containerRef}>
      {isMounted && hasMeasuredCanvasViewport ? (
        <ReactFlow<Node<KanbanCardNodeData>>
          className="background-flow dark"
          defaultViewport={CANVAS_DEFAULT_VIEWPORT}
          deleteKeyCode={null}
          edges={graph.edges}
          edgesFocusable={true}
          elementsSelectable={true}
          maxZoom={4}
          minZoom={0.15}
          nodeExtent={WORLD_EXTENT}
          nodes={graph.nodes}
          nodesConnectable={true}
          nodesDraggable={true}
          nodesFocusable={true}
          nodeTypes={nodeTypes}
          onConnect={graph.onConnect}
          onInit={graph.onInit}
          onlyRenderVisibleElements
          onNodeClick={(_, node) => graph.onNodeClick(node.id)}
          onNodeDragStop={(_, node) => {
            updateBoardPosition(node.id, node.position);
          }}
          onNodesChange={graph.onNodesChange}
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
                  onClick={dismissError}
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
