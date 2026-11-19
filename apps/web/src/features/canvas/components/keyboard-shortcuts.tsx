"use client";

import { useReactFlow } from "@xyflow/react";
import { KeyboardIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useEffectEvent } from "react";

export const CANVAS_DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;

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

const CANVAS_SHORTCUTS = [
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
] as const;

interface KeyboardShortcutsProps {
  onNewTask?: () => void;
  onRemoveSelected?: () => void;
  onToggleHelp?: () => void;
}

export function KeyboardShortcuts({
  onNewTask,
  onRemoveSelected,
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
        setViewport(CANVAS_DEFAULT_VIEWPORT, { duration: 180 });
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
        // React Flow handles Escape selection.
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

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded-xs border border-white/15 bg-white/8 px-1 py-0.5 font-mono text-[0.6rem] text-white/60 leading-none">
      {children}
    </kbd>
  );
}

export function KeyboardHelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fade-in slide-in-from-bottom-2 pointer-events-auto w-64 animate-in rounded-sm border border-white/10 bg-[#020617]/88 p-4 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur-2xl duration-200"
      style={{ backdropFilter: "blur(20px)" }}
    >
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
                        <Fragment key={key}>
                          <span className="text-[0.55rem] text-white/20">
                            or
                          </span>
                          <Kbd>{key}</Kbd>
                        </Fragment>
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
