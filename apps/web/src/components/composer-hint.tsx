import { XIcon } from "lucide-react";

export function ComposerHint({
  onDismiss,
  selectedBoardTitle,
  sessionMessage,
}: {
  onDismiss: () => void;
  selectedBoardTitle?: string;
  sessionMessage: string;
}) {
  return (
    <div className="pointer-events-none mb-2 flex items-start justify-between gap-3 rounded-xs border border-white/10 bg-black/45 px-3 py-2 text-[11px] text-white/70 leading-4 shadow-lg backdrop-blur-md">
      <span>
        Boards persist across browsers on this machine.{" "}
        {selectedBoardTitle
          ? `${selectedBoardTitle} is selected. ${sessionMessage}`
          : "Open or select a board, then send the first prompt to start its OpenCode session."}
      </span>
      <button
        aria-label="Dismiss composer hint"
        className="pointer-events-auto rounded-xs p-0.5 text-white/35 transition-colors hover:bg-white/8 hover:text-white/70"
        onClick={onDismiss}
        type="button"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
