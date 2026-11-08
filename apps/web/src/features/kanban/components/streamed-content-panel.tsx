"use client";

import { ArrowDownIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const MARKDOWN_PLUGINS = [remarkGfm];
const MAX_SCROLL_DISTANCE_FROM_LATEST = 48;

interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export function isNearLatestScrollPosition({
  clientHeight,
  scrollHeight,
  scrollTop,
}: ScrollMetrics): boolean {
  return (
    scrollHeight - scrollTop - clientHeight <= MAX_SCROLL_DISTANCE_FROM_LATEST
  );
}

const MarkdownContent = memo(function MarkdownContent({
  className,
  content,
}: {
  className: string;
  content: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{content}</ReactMarkdown>
    </div>
  );
});

export function StreamedContentPanel({
  className,
  content,
  kind,
}: {
  className: string;
  content: string;
  kind: "thinking" | "response";
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const updateFollowState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const followsLatest = isNearLatestScrollPosition(viewport);
    followsLatestRef.current = followsLatest;
    setShowJumpToLatest(!followsLatest);
  }, []);

  const jumpToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    followsLatestRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
    setShowJumpToLatest(false);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (content.length === 0) {
      viewport.scrollTop = 0;
      followsLatestRef.current = true;
      setShowJumpToLatest(false);
      return;
    }

    if (followsLatestRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      setShowJumpToLatest(false);
    }
  }, [content]);

  return (
    <div
      className={cn(
        "nodrag nowheel ml-5 max-h-56 overflow-y-auto overscroll-contain rounded-xs border px-3 py-2.5",
        className
      )}
      onScroll={updateFollowState}
      ref={viewportRef}
    >
      <MarkdownContent
        className="text-[0.72rem] leading-relaxed"
        content={content}
      />
      {showJumpToLatest && (
        <div className="sticky bottom-0 flex justify-end pt-2">
          <button
            aria-label={`Jump to latest ${kind}`}
            className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-[#111]/95 px-2.5 py-1 font-medium text-[0.65rem] text-white/75 shadow-lg transition-colors hover:bg-white/10 hover:text-white"
            onClick={jumpToLatest}
            type="button"
          >
            <ArrowDownIcon aria-hidden="true" className="size-3" />
            Jump to latest
          </button>
        </div>
      )}
    </div>
  );
}
