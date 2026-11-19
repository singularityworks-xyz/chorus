"use client";

import { ArrowDownIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getEarlierStreamContentRange,
  getLatestStreamContentRange,
  type StreamContentRange,
} from "@/features/kanban/utils/stream-content-page";
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
  const pendingScrollRef = useRef<"earlier" | "later" | "latest" | null>(null);
  const [pinnedPage, setPinnedPage] = useState<StreamContentRange | null>(null);
  const [laterPages, setLaterPages] = useState<
    { followsLatest: boolean; range: StreamContentRange }[]
  >([]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const latestPage = getLatestStreamContentRange(content);
  const page = pinnedPage ?? latestPage;
  const isLatestPage = page.end === content.length;
  const pageContent = content.slice(page.start, page.end);

  const updateFollowState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const followsLatest =
      pinnedPage === null && isNearLatestScrollPosition(viewport);
    followsLatestRef.current = followsLatest;
    setShowJumpToLatest(!followsLatest);
  }, [pinnedPage]);

  const showEarlier = useCallback(() => {
    const earlierPage = getEarlierStreamContentRange(content, page);
    if (!earlierPage) {
      return;
    }

    pendingScrollRef.current = "earlier";
    followsLatestRef.current = false;
    setShowJumpToLatest(true);
    setLaterPages((pages) => [
      { followsLatest: isLatestPage, range: page },
      ...pages,
    ]);
    setPinnedPage(earlierPage);
  }, [content, isLatestPage, page]);

  const showLater = useCallback(() => {
    const [nextPage, ...remainingPages] = laterPages;
    if (!nextPage) {
      return;
    }

    pendingScrollRef.current = "later";
    setLaterPages(remainingPages);
    if (nextPage.followsLatest) {
      followsLatestRef.current = true;
      setShowJumpToLatest(false);
      setPinnedPage(null);
      return;
    }

    followsLatestRef.current = false;
    setShowJumpToLatest(true);
    setPinnedPage(nextPage.range);
  }, [laterPages]);

  const jumpToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    followsLatestRef.current = true;
    pendingScrollRef.current = "latest";
    setPinnedPage(null);
    setLaterPages([]);
    setShowJumpToLatest(false);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const pendingScroll = pendingScrollRef.current;
    if (pendingScroll === "earlier" || pendingScroll === "later") {
      viewport.scrollTop = 0;
      pendingScrollRef.current = null;
      return;
    }

    if (pendingScroll === "latest") {
      viewport.scrollTop = viewport.scrollHeight;
      pendingScrollRef.current = null;
      return;
    }

    if (pageContent.length === 0) {
      viewport.scrollTop = 0;
      followsLatestRef.current = true;
      setShowJumpToLatest(false);
      return;
    }

    if (isLatestPage && followsLatestRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      setShowJumpToLatest(false);
    } else if (!isLatestPage) {
      setShowJumpToLatest(true);
    }
  }, [isLatestPage, pageContent]);

  return (
    <div
      className={cn(
        "nodrag nowheel ml-5 max-h-56 overflow-y-auto overscroll-contain rounded-xs border px-3 py-2.5",
        className
      )}
      onScroll={updateFollowState}
      ref={viewportRef}
    >
      {(page.start > 0 || page.end < content.length) && (
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-[#111]/95 py-1">
          {page.start > 0 ? (
            <button
              aria-label={`Show earlier ${kind} output`}
              className="nodrag rounded-sm px-1.5 py-0.5 text-[0.62rem] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              onClick={showEarlier}
              type="button"
            >
              Earlier
            </button>
          ) : (
            <span />
          )}
          <span className="text-[0.58rem] text-white/35">
            {page.start.toLocaleString()}–{page.end.toLocaleString()} of{" "}
            {content.length.toLocaleString()} characters
          </span>
          {page.end < content.length && laterPages.length > 0 ? (
            <button
              aria-label={`Show later ${kind} output`}
              className="nodrag rounded-sm px-1.5 py-0.5 text-[0.62rem] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              onClick={showLater}
              type="button"
            >
              Later
            </button>
          ) : (
            <span />
          )}
        </div>
      )}
      <MarkdownContent
        className="text-[0.72rem] leading-relaxed"
        content={pageContent}
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
