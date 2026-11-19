"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGitStatus, type GitStatus } from "@/lib/opencode-client";

export function useGitStatus(
  filePath: string,
  initialStatus?: GitStatus | null
) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(
    initialStatus ?? null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    setLoading(true);
    fetchGitStatus(filePath, { signal: controller.signal })
      .then((status) => {
        if (!controller.signal.aborted) {
          setGitStatus(status);
        }
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Could not load repository status. Retry."
          );
        }
      })
      .finally(() => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setLoading(false);
        }
      });
  }, [filePath]);

  useEffect(() => {
    refresh();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [refresh]);

  return { error, gitStatus, loading, refresh };
}
