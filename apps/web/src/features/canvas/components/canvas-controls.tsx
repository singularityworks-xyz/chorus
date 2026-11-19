"use client";

import { Panel, useReactFlow } from "@xyflow/react";
import { MinusIcon, PlusIcon } from "lucide-react";

export function CanvasControls() {
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
