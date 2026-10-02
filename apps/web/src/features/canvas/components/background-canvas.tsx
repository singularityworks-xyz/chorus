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
  useReactFlow,
  type Viewport,
} from "@xyflow/react";
import { KeyboardIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
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
  BOARD_CARD_HEIGHT,
  BOARD_CARD_WIDTH,
  computeBoardLayout,
  getAutoLayoutBoardIds,
} from "@/features/canvas/lib/board-layout";
import type { Columns } from "@/features/kanban/components/kanban";
import {
  KANBAN_CARD_NODE_TYPE,
  KanbanCardNode,
  type KanbanCardNodeData,
} from "@/features/kanban/components/kanban-card-node";
import { displayedPosition } from "@/features/workspace/reducer";
import type {
  WorkspaceBoard,
  WorkspacePreferences,
} from "@/features/workspace/types";
import { useWorkspace } from "@/features/workspace/workspace-context";

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const WORLD_EXTENT: CoordinateExtent = [
  [-2_000_000, -2_000_000],
  [2_000_000, 2_000_000],
];

const nodeTypes = {
  [KANBAN_CARD_NODE_TYPE]: KanbanCardNode,
};
const AUTO_LAYOUT_NODE_CLASS =
  "transition-[transform,width,height] duration-[560ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === "BUTTON" ||
    target.tagName === "INPUT" ||
    target.tagName === "SELECT" ||
    target.tagName === "TEXTAREA"
  );
}

/**
 * All keyboard shortcuts wired up for the Chorus canvas.
 * Exposed as a constant so the help panel can reference the same list.
 */
export const CANVAS_SHORTCUTS = [
  {
    group: "Canvas",
    shortcuts: [
      { keys: ["Scroll"], label: "Pan canvas" },
      { keys: ["Ctrl", "Scroll"], label: "Zoom in/out" },
      { keys: ["Shift", "Scroll"], label: "Toggle pan direction + pan" },
      { keys: ["+", "="], label: "Zoom in" },
      { keys: ["-"], label: "Zoom out" },
      { keys: ["0"], label: "Reset view" },
      { keys: ["F"], label: "Fit view" },
      { keys: ["?"], label: "Toggle shortcuts" },
    ],
  },
  {
    group: "Tasks",
    shortcuts: [
      { keys: ["N"], label: "New task" },
      { keys: ["Delete", "⌫"], label: "Remove selected card" },
      { keys: ["Esc"], label: "Deselect / dismiss" },
    ],
  },
  {
    group: "Review",
    shortcuts: [
      { keys: ["A"], label: "Approve selected" },
      { keys: ["R"], label: "Reject selected" },
    ],
  },
] as const;

interface KeyboardShortcutsProps {
  onApproveSelected?: () => void;
  onNewTask?: () => void;
  onRejectSelected?: () => void;
  onRemoveSelected?: () => void;
  onToggleHelp?: () => void;
}

function KeyboardShortcuts({
  onNewTask,
  onRemoveSelected,
  onApproveSelected,
  onRejectSelected,
  onToggleHelp,
}: KeyboardShortcutsProps) {
  const { setViewport, zoomIn, zoomOut, fitView } = useReactFlow();

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }

    switch (event.key) {
      case "+":
      case "=":
        event.preventDefault();
        zoomIn({ duration: 140 });
        break;

      case "-":
      case "_":
        event.preventDefault();
        zoomOut({ duration: 140 });
        break;

      case "0":
        event.preventDefault();
        setViewport(DEFAULT_VIEWPORT, { duration: 180 });
        break;

      case "f":
      case "F":
        event.preventDefault();
        fitView({ duration: 300, padding: 0.1 });
        break;

      case "n":
      case "N":
        event.preventDefault();
        onNewTask?.();
        break;

      case "Delete":
      case "Backspace":
        event.preventDefault();
        onRemoveSelected?.();
        break;

      case "Escape":
        // Let React Flow handle deselection natively; no preventDefault
        break;

      case "a":
      case "A":
        event.preventDefault();
        onApproveSelected?.();
        break;

      case "r":
      case "R":
        event.preventDefault();
        onRejectSelected?.();
        break;

      case "?":
        event.preventDefault();
        onToggleHelp?.();
        break;

      default:
        break;
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return null;
}

function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <Panel
      className="!right-4 !bottom-auto !top-[4.5rem] md:!top-auto md:!bottom-[4.25rem] flex flex-col items-center gap-1 rounded-sm border border-white/10 bg-[#0f0f0f]/90 p-1.5 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-xl"
      position="top-right"
      style={{ margin: 0 }}
    >
      <button
        aria-label="Zoom in"
        className="flex size-8 items-center justify-center rounded-xs text-white/35 transition-colors duration-150 hover:bg-white/10 hover:text-white/60"
        onClick={() => zoomIn({ duration: 140 })}
        title="Zoom in (+)"
        type="button"
      >
        <PlusIcon className="size-4" />
      </button>
      <button
        aria-label="Zoom out"
        className="flex size-8 items-center justify-center rounded-xs text-white/35 transition-colors duration-150 hover:bg-white/10 hover:text-white/60"
        onClick={() => zoomOut({ duration: 140 })}
        title="Zoom out (-)"
        type="button"
      >
        <MinusIcon className="size-4" />
      </button>
      <div className="mx-1 my-0.5 h-px w-6 bg-white/10" />
      <button
        aria-label="Fit view"
        className="flex size-8 items-center justify-center rounded-xs text-white/35 transition-colors duration-150 hover:bg-white/10 hover:text-white/60"
        onClick={() => fitView({ duration: 300, padding: 0.1 })}
        title="Fit view (F)"
        type="button"
      >
        <svg
          aria-hidden="true"
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="14"
          xmlns="http://www.w3.org/2000/svg"
        >
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <line x1="21" x2="14" y1="3" y2="10" />
          <line x1="3" x2="10" y1="21" y2="14" />
        </svg>
      </button>
    </Panel>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded-xs border border-white/15 bg-white/8 px-1 py-0.5 font-mono text-[0.6rem] text-white/60 leading-none">
      {children}
    </kbd>
  );
}

function KeyboardHelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fade-in slide-in-from-bottom-2 pointer-events-auto w-64 animate-in rounded-sm border border-white/10 bg-[#020617]/88 p-4 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur-2xl duration-200"
      style={{ backdropFilter: "blur(20px)" }}
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-semibold text-[0.72rem] text-white/70 uppercase tracking-widest">
          <KeyboardIcon className="size-3 text-white/40" />
          Shortcuts
        </span>
        <button
          aria-label="Close shortcuts panel"
          className="rounded-xs p-0.5 text-white/25 transition-colors hover:bg-white/8 hover:text-white/60"
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      </div>

      {/* Groups */}
      <div className="flex flex-col gap-3">
        {CANVAS_SHORTCUTS.map((group) => (
          <div key={group.group}>
            <div className="mb-1.5 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              {group.group}
            </div>
            <div className="flex flex-col gap-1">
              {group.shortcuts.map((shortcut) => (
                <div
                  className="flex items-center justify-between"
                  key={shortcut.label}
                >
                  <span className="text-[0.7rem] text-white/50">
                    {shortcut.label}
                  </span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) =>
                      i === 0 ? (
                        <Kbd key={key}>{key}</Kbd>
                      ) : (
                        <>
                          <span className="text-[0.55rem] text-white/20">
                            or
                          </span>
                          <Kbd key={key}>{key}</Kbd>
                        </>
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function createKanbanCardNode(
  board: WorkspaceBoard,
  layout: ReturnType<typeof computeBoardLayout>,
  selected: boolean,
  onRemove: (id: string) => void,
  onUpdateColumns: (id: string, columns: Columns) => void,
  // The optimistic guess wins over `board.position` until the server confirms,
  // otherwise the board snaps back to its old spot for the length of the
  // mutation round trip -- exactly what the guess exists to prevent.
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
      onRemove,
      onUpdateColumns,
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

function reconcileNodes(
  currentNodes: Node<KanbanCardNodeData>[],
  boards: WorkspaceBoard[],
  layout: ReturnType<typeof computeBoardLayout>,
  selectedBoardId: string | null,
  onRemove: (id: string) => void,
  onUpdateColumns: (id: string, columns: Columns) => void,
  positionOf: (board: WorkspaceBoard) => { x: number; y: number }
): Node<KanbanCardNodeData>[] {
  const currentNodesById = new Map(currentNodes.map((node) => [node.id, node]));

  return boards.map((board) => {
    const nextNode = createKanbanCardNode(
      board,
      layout,
      board.boardId === selectedBoardId,
      onRemove,
      onUpdateColumns,
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

export function BackgroundCanvas() {
  const {
    boards,
    pendingDrags,
    boardLayoutVersion,
    clearSelection,
    preferences,
    removeBoard,
    selectedBoardId,
    selectBoard,
    updateBoardColumns,
    updateBoardPosition,
  } = useWorkspace();
  const [nodes, setNodes] = useState<Node<KanbanCardNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [fitViewToken, setFitViewToken] = useState(0);
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

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    // Let Kanban columns and other scrollable children handle their own scroll.
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
      // ── Pinch-to-zoom / Ctrl+scroll ─────────────────────────────────────
      // Use a small factor so the zoom feels natural.
      const zoomFactor = 0.002;
      const newZoom = Math.max(
        0.15,
        Math.min(4, current.zoom * (1 - event.deltaY * zoomFactor))
      );
      rf.setViewport({ x: current.x, y: current.y, zoom: newZoom });
    } else {
      // ── Two-finger pan / scroll-wheel pan ────────────────────────────────
      // Consume both axes so touchpad diagonal swipes work correctly.
      // Shift+scroll remaps deltaY → horizontal (common browser convention).
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

  // A board with an in-flight optimistic drag renders at the guessed position
  // until the server's `board.moved` lands (or the guess expires). Recomputed per
  // render rather than memoised on `pendingDrags` alone, because the deadline is
  // wall-clock: an unexpired guess becomes expired without any state change.
  const positionOfBoard = useCallback(
    (board: WorkspaceBoard) =>
      displayedPosition(board, pendingDrags, Date.now()),
    [pendingDrags]
  );

  const handleUpdateColumns = useCallback(
    (id: string, columns: Columns) => {
      updateBoardColumns(id, columns);
    },
    [updateBoardColumns]
  );

  const handleRemoveBoard = useCallback(
    (boardId: string) => {
      removeBoard(boardId);
      setNodes((currentNodes) =>
        currentNodes.filter((node) => node.id !== boardId)
      );
      setEdges((currentEdges) =>
        currentEdges.filter(
          (edge) => edge.source !== boardId && edge.target !== boardId
        )
      );
    },
    [removeBoard]
  );

  /**
   * Remove whichever card is currently selected (first selected node).
   * When real selection state is wired, pass the selected node id here.
   */
  const handleRemoveSelected = useCallback(() => {
    // Future: derive from selected nodes. For now this is a no-op placeholder.
  }, []);

  const handleApproveSelected = useCallback(() => {
    // Future: approve the card currently in the `approve` lane that is selected.
  }, []);

  const handleRejectSelected = useCallback(() => {
    // Future: reject the card currently in the `approve` lane that is selected.
  }, []);

  const handleNewTask = useCallback(() => {
    // Future: open the "Create Task" modal / focus the queue column's create button.
  }, []);

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
          handleUpdateColumns,
          positionOfBoard
        )
      );
    });
  }, [
    boardViewMode,
    boards,
    canvasSize.width,
    handleRemoveBoard,
    handleUpdateColumns,
    positionOfBoard,
    selectedBoardId,
  ]);

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

  // Navigate to board when selected from dropdown (not from canvas click)
  useEffect(() => {
    if (!(selectedBoardId && rfInstanceRef.current) || isNodeClickRef.current) {
      isNodeClickRef.current = false;
      return;
    }

    const node = rfInstanceRef.current.getNode(selectedBoardId);
    if (!node) {
      return;
    }

    const nodeWidth = 1280; // KANBAN_CARD_WIDTH from kanban-card-node.tsx
    const nodeHeight = 720; // KANBAN_CARD_HEIGHT from kanban-card-node.tsx

    rfInstanceRef.current.setCenter(
      node.position.x + nodeWidth / 2,
      node.position.y + nodeHeight / 2,
      { zoom: 1, duration: 300 }
    );
  }, [selectedBoardId]);

  return (
    <div className="h-full w-full" ref={containerRef}>
      {isMounted ? (
        <ReactFlow
          className="background-flow dark"
          defaultViewport={DEFAULT_VIEWPORT}
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
            onApproveSelected={handleApproveSelected}
            onNewTask={handleNewTask}
            onRejectSelected={handleRejectSelected}
            onRemoveSelected={handleRemoveSelected}
            onToggleHelp={handleToggleHelp}
          />

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

      {/* Keyboard help panel + icon button — portalled to document.body to
          escape the z-10 stacking context imposed by the page layout wrapper. */}
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
