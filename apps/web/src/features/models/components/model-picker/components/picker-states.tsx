import type { OpencodeModelSummary } from "@chorus/contracts";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function LoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="flex items-center gap-3 rounded-xs border border-white/6 bg-white/[0.02] px-4 py-3 text-[11px] text-white/58">
        <LoaderCircle className="size-3.5 animate-spin text-white/55" />
        Fetching models from OpenCode
      </div>
    </div>
  );
}

export function EmptyState({ searchQuery }: { searchQuery: string }) {
  const hasSearchQuery = searchQuery.trim().length > 0;

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="max-w-xs rounded-xs border border-white/6 bg-white/[0.02] px-4 py-3 text-center">
        <div className="text-[12px] text-white/78">
          {hasSearchQuery ? "No matching models" : "No models available"}
        </div>
        <div className="mt-1 text-[11px] text-white/46">
          {hasSearchQuery
            ? `No models matched "${searchQuery.trim()}".`
            : "Configure an OpenCode provider to populate this list."}
        </div>
      </div>
    </div>
  );
}

export function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        "rounded-xs border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em]",
        connected
          ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200/75"
          : "border-white/8 bg-white/[0.03] text-white/42"
      )}
    >
      {connected ? "Connected" : "Detected"}
    </span>
  );
}

export function FeatureBadge({
  label,
  tone = "default",
}: {
  label: string;
  tone?: "connected" | "default";
}) {
  return (
    <span
      className={cn(
        "rounded-xs border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em]",
        tone === "connected"
          ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200/75"
          : "border-white/8 bg-white/[0.03] text-white/42"
      )}
    >
      {label}
    </span>
  );
}

export function StatusBadge({
  status,
}: {
  status: NonNullable<OpencodeModelSummary["status"]>;
}) {
  return (
    <span
      className={cn(
        "rounded-xs border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em]",
        getStatusBadgeClasses(status)
      )}
    >
      {status}
    </span>
  );
}

function getStatusBadgeClasses(
  status: NonNullable<OpencodeModelSummary["status"]>
) {
  if (status === "deprecated") {
    return "border-amber-400/20 bg-amber-400/10 text-amber-200/75";
  }

  if (status === "beta") {
    return "border-sky-400/20 bg-sky-400/10 text-sky-200/75";
  }

  if (status === "alpha") {
    return "border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200/75";
  }

  return "border-white/8 bg-white/[0.03] text-white/42";
}
