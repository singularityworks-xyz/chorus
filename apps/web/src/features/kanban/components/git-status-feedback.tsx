"use client";

import { LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function GitStatusFeedback({
  error,
  loading,
  onRetry,
}: {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  if (!(loading || error)) {
    return null;
  }

  return (
    <span
      className={cn(
        "nodrag inline-flex min-w-0 items-center gap-1 rounded-xs font-mono text-[0.6rem] leading-none",
        error ? "text-rose-300/90" : "text-white/40"
      )}
      role={error ? "alert" : "status"}
      title={error ?? "Checking repository status"}
    >
      {error ? (
        <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3 shrink-0 animate-spin"
        />
      )}
      <span className="min-w-0 truncate">
        {error ? "Status unavailable" : "Checking status…"}
      </span>
      {error && <span className="sr-only">{error}</span>}
      {error && (
        <button
          aria-label="Retry repository status"
          className="shrink-0 rounded-xs px-1 py-1 underline underline-offset-2 hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
          disabled={loading}
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      )}
    </span>
  );
}
