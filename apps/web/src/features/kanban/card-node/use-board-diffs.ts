"use client";

import { useCallback, useState } from "react";
import { fetchSessionDiff, type SessionFileDiff } from "@/lib/opencode-client";

export function useBoardDiffs(sessionId?: string) {
  const [diffVisible, setDiffVisible] = useState(false);
  const [diffFiles, setDiffFiles] = useState<SessionFileDiff[]>([]);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffNotice, setDiffNotice] = useState<string | null>(null);
  const [selectedDiffFile, setSelectedDiffFile] =
    useState<SessionFileDiff | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);

  const handleViewDiffs = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    setIsLoadingDiff(true);
    setDiffError(null);
    setDiffNotice(null);
    try {
      const diffs = await fetchSessionDiff(sessionId);
      setDiffFiles(diffs);
      if (diffs.length > 0) {
        setSelectedDiffFile(diffs[0]);
        setDiffVisible(true);
      } else {
        setDiffNotice("No file changes are available for this session.");
      }
    } catch (error) {
      setDiffError(
        error instanceof Error
          ? error.message
          : "Could not load session diffs. Try again."
      );
    } finally {
      setIsLoadingDiff(false);
    }
  }, [sessionId]);

  const handleSelectDiffFile = useCallback((diff: SessionFileDiff) => {
    setSelectedDiffFile(diff);
    setDiffVisible(true);
  }, []);

  const handleCloseDiff = useCallback(() => {
    setDiffVisible(false);
  }, []);

  return {
    diffError,
    diffFiles,
    diffNotice,
    diffVisible,
    handleCloseDiff,
    handleSelectDiffFile,
    handleViewDiffs,
    isLoadingDiff,
    selectedDiffFile,
  };
}
