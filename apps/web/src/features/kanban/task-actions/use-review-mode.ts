"use client";

import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-context";

export function useReviewMode(boardId: string, reviewMode: "manual" | "auto") {
  const [localReviewMode, setLocalReviewMode] = useState(reviewMode);
  const [reviewModePending, setReviewModePending] = useState(false);
  const [reviewModeError, setReviewModeError] = useState<string | null>(null);
  const reviewModeRef = useRef(reviewMode);
  const reviewModeCommandRef = useRef(0);
  const { updateBoardReviewMode } = useWorkspace();

  useEffect(() => {
    reviewModeRef.current = reviewMode;
    setLocalReviewMode(reviewMode);
    setReviewModeError(null);
  }, [reviewMode]);

  useEffect(
    () => () => {
      reviewModeCommandRef.current += 1;
    },
    []
  );

  const handleReviewModeChange = useCallback(
    async (mode: "manual" | "auto") => {
      const commandId = reviewModeCommandRef.current + 1;
      reviewModeCommandRef.current = commandId;
      const previousMode = reviewModeRef.current;
      reviewModeRef.current = mode;
      setLocalReviewMode(mode);
      setReviewModePending(true);
      setReviewModeError(null);
      posthog.capture("kanban_review_mode_changed", { boardId, mode });

      try {
        await updateBoardReviewMode(boardId, mode);
      } catch {
        if (reviewModeCommandRef.current === commandId) {
          reviewModeRef.current = previousMode;
          setLocalReviewMode(previousMode);
          setReviewModeError(
            "Could not save the review mode. Your previous setting was restored; try again."
          );
        }
      } finally {
        if (reviewModeCommandRef.current === commandId) {
          setReviewModePending(false);
        }
      }
    },
    [boardId, updateBoardReviewMode]
  );

  return {
    handleReviewModeChange,
    reviewMode: localReviewMode,
    reviewModeError,
    reviewModePending,
  };
}
