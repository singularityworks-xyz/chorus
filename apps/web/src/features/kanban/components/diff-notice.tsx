import { cn } from "@/lib/utils";

export function DiffNotice({
  error,
  notice,
  onRetry,
  retrying,
}: {
  error: string | null;
  notice: string | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  const message = error ?? notice;
  if (!message) {
    return null;
  }

  const className = cn(
    "border-b px-3 py-1.5 text-[0.68rem]",
    error
      ? "border-rose-500/15 bg-rose-500/[0.03] text-rose-300/85"
      : "border-white/5 text-white/45"
  );

  if (error) {
    return (
      <div
        className={cn(className, "flex items-center justify-between gap-3")}
        role="alert"
      >
        <span className="min-w-0">{message}</span>
        <button
          aria-label="Retry loading session diffs"
          className="nodrag shrink-0 rounded-xs px-1.5 py-0.5 underline underline-offset-2 hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
          disabled={retrying}
          onClick={onRetry}
          type="button"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }

  return (
    <p className={className} role="status">
      {message}
    </p>
  );
}
