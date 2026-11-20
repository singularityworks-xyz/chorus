"use client";

import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { KanbanCardNodeData } from "@/features/kanban/card-node/node-data";
import { hasCanvasViewport } from "../lib/canvas-viewport";

export type CanvasFlowInstance = ReactFlowInstance<
  Node<KanbanCardNodeData>,
  Edge
>;

export function useCanvasViewport() {
  const [isMounted, setIsMounted] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ height: 0, width: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const flowInstanceRef = useRef<CanvasFlowInstance | null>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".nowheel")
    ) {
      return;
    }

    event.preventDefault();

    const flow = flowInstanceRef.current;
    if (!flow) {
      return;
    }

    const current = flow.getViewport();
    if (event.ctrlKey || event.metaKey) {
      const zoomFactor = 0.002;
      const zoom = Math.max(
        0.15,
        Math.min(4, current.zoom * (1 - event.deltaY * zoomFactor))
      );
      flow.setViewport({ x: current.x, y: current.y, zoom });
      return;
    }

    const panFactor = 1.2;
    const dx = event.shiftKey
      ? -event.deltaY * panFactor
      : -event.deltaX * panFactor;
    const dy = event.shiftKey ? 0 : -event.deltaY * panFactor;
    flow.setViewport({
      x: current.x + dx,
      y: current.y + dy,
      zoom: current.zoom,
    });
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setCanvasSize((current) =>
        current.width === width && current.height === height
          ? current
          : { height, width }
      );
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return {
    canvasSize,
    containerRef,
    flowInstanceRef,
    hasMeasuredCanvasViewport: hasCanvasViewport(
      canvasSize.width,
      canvasSize.height
    ),
    isMounted,
  };
}
