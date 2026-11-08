import { ArrowUp, Book, FileText, Folder, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AutocompleteItem } from "@/hooks/use-autocomplete";

interface CommandPaletteProps {
  anchorRect: { top: number; left: number; width: number } | null;
  error: string | null;
  isLoading: boolean;
  items: AutocompleteItem[];
  onClose: () => void;
  onExpandDirectory?: (item: AutocompleteItem) => void;
  onRetry: () => void;
  onSelect: (item: AutocompleteItem) => void;
}

const ICONS = {
  command: Terminal,
  skill: Book,
  file: FileText,
};

export function CommandPalette({
  items,
  error,
  isLoading,
  onSelect,
  onClose,
  onExpandDirectory,
  onRetry,
  anchorRect,
}: CommandPaletteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      const currentItems = itemsRef.current;
      if (currentItems.length === 0) {
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % currentItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(
          (prev) => (prev - 1 + currentItems.length) % currentItems.length
        );
      } else if (e.key === "Tab") {
        e.preventDefault();
        const selected = currentItems[selectedIndex];
        if (selected) {
          if (selected.isDirectory && onExpandDirectory) {
            onExpandDirectory(selected);
          } else {
            onSelect(selected);
          }
        }
      }
    },
    [selectedIndex, onSelect, onClose, onExpandDirectory]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    const selectedEl = listRef.current?.querySelector(
      `[data-index="${selectedIndex}"]`
    );
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!anchorRect || (!(isLoading || error) && items.length === 0)) {
    return null;
  }

  const SIDE_PADDING = 8;
  const top = anchorRect.top - 4;
  const panelWidth = Math.min(
    Math.max(anchorRect.width, 320),
    window.innerWidth - SIDE_PADDING * 2
  );
  // Clamp left so we don't overflow the right edge of the viewport
  const clampedLeft = Math.min(
    anchorRect.left,
    window.innerWidth - panelWidth - SIDE_PADDING
  );
  const left = Math.max(SIDE_PADDING, clampedLeft);
  const width = panelWidth;

  return (
    <div
      className="fixed z-50 max-h-64 w-full overflow-hidden rounded-xl border border-white/10 bg-[#1a1a1a] shadow-2xl backdrop-blur-xl"
      style={{
        top,
        left,
        width,
        transform: "translateY(-100%)",
      }}
    >
      <div aria-busy={isLoading} className="max-h-64 overflow-y-auto p-1">
        {isLoading && (
          <div
            className="px-3 py-3 text-center text-white/40 text-xs"
            role="status"
          >
            Loading suggestions…
          </div>
        )}
        {error && !isLoading && (
          <div
            className="flex items-center gap-3 px-3 py-2 text-xs"
            role="alert"
          >
            <span className="min-w-0 flex-1 text-rose-200/90">{error}</span>
            <button
              className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              onClick={onRetry}
              type="button"
            >
              Retry
            </button>
          </div>
        )}
        {!(isLoading || error) && items.length === 0 && (
          <div
            className="px-3 py-3 text-center text-white/40 text-xs"
            role="status"
          >
            No suggestions found.
          </div>
        )}
        {items.length > 0 && (
          <div ref={listRef} role="listbox">
            {items.map((item, index) => {
              const isDirectory = item.isDirectory === true;
              let Icon: typeof FileText = FileText;
              if (isDirectory) {
                Icon = Folder;
              } else if (item.type != null && item.type in ICONS) {
                Icon = ICONS[item.type];
              }

              return (
                <div
                  aria-selected={index === selectedIndex}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-white/10 data-[selected=true]:bg-white/15"
                  data-index={index}
                  data-selected={index === selectedIndex}
                  key={item.id}
                  onClick={() => onSelect(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(item);
                    }
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  role="option"
                  tabIndex={0}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      isDirectory ? "text-amber-400/70" : "text-white/50"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-white/90">
                      {item.label}
                    </div>
                    {item.description && (
                      <div className="truncate text-white/40 text-xs">
                        {item.description}
                      </div>
                    )}
                  </div>
                  {isDirectory && onExpandDirectory && (
                    <span className="text-[10px] text-white/25">Tab ↹</span>
                  )}
                  {index === selectedIndex && !isDirectory && (
                    <ArrowUp className="h-3 w-3 rotate-90 text-white/30" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
