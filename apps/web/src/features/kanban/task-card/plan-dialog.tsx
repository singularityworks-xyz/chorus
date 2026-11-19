"use client";

import { ChorusMonaco } from "@chorus/monaco";
import { XIcon } from "lucide-react";
import { createPortal } from "react-dom";

interface TaskPlanDialogProps {
  onChange(plan: string): void;
  onClose(): void;
  open: boolean;
  plan: string;
}

export function TaskPlanDialog({
  onChange,
  onClose,
  open,
  plan,
}: TaskPlanDialogProps) {
  if (!open) {
    return null;
  }

  return createPortal(
    <>
      <button
        aria-label="Close implementation plan"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={onClose}
        type="button"
      />
      <div
        aria-label="Implementation Plan"
        aria-modal="true"
        className="fixed inset-0 z-[51] m-auto flex h-[80vh] w-[80vw] min-w-[600px] flex-col rounded-lg border border-white/10 bg-[#0d0d0d] shadow-2xl max-md:h-full max-md:w-full max-md:min-w-0 max-md:rounded-none max-md:border-0"
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
          <span className="font-medium text-[0.8rem] text-amber-400 uppercase tracking-wider">
            Implementation Plan
          </span>
          <button
            aria-label="Close"
            className="rounded-xs p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
            onClick={onClose}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-hidden p-3">
          <ChorusMonaco
            filePath="plan.md"
            height="100%"
            language="markdown"
            onChange={(value) => onChange(value ?? "")}
            value={plan}
          />
        </div>
      </div>
    </>,
    document.body
  );
}
