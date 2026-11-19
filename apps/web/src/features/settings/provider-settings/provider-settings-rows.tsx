import type {
  OpencodeCredentialSummary,
  OpencodeProviderStatus,
} from "@chorus/contracts";
import { getProviderIconData } from "@/components/icons";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function ProviderMark({
  providerID,
  providerName,
  className,
}: {
  className?: string;
  providerID?: string;
  providerName?: string;
}) {
  const iconData =
    getProviderIconData(providerID, providerName) ??
    getProviderIconData("opencode", "OpenCode");

  if (!iconData) {
    return null;
  }

  const paths = Array.from(iconData.body.matchAll(/<path\s+([^>]*?)\/?>/g));

  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 fill-current", className)}
      viewBox={iconData.viewBox}
    >
      {paths.map((match) => (
        <path
          key={`${iconData.name}-${match[1] ?? ""}`}
          {...parseSvgPathAttributes(match[1] ?? "")}
        />
      ))}
    </svg>
  );
}

function parseSvgPathAttributes(
  source: string
): React.SVGProps<SVGPathElement> {
  const attributes: Record<string, string> = {};

  for (const match of source.matchAll(/([:\w-]+)="([^"]*)"/g)) {
    const [, rawName, value] = match;
    if (!(rawName && value !== undefined)) {
      continue;
    }

    const normalizedName = rawName.replace(/-([a-z])/g, (_, char: string) =>
      char.toUpperCase()
    );
    attributes[normalizedName] = value;
  }

  return attributes;
}

export function ProviderStatusRow({
  provider,
}: {
  provider: OpencodeProviderStatus;
}) {
  return (
    <div className="flex items-center gap-2.5 border border-white/8 bg-white/[0.025] px-2.5 py-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/70">
        <ProviderMark providerID={provider.id} providerName={provider.name} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-[11px] text-white/88 uppercase tracking-[0.08em]">
            {provider.name}
          </span>
          <span
            className={cn(
              "shrink-0 border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em]",
              provider.connected
                ? "border-emerald-400/18 bg-emerald-400/[0.08] text-emerald-200/78"
                : "border-white/8 bg-white/[0.04] text-white/38"
            )}
          >
            {provider.connected ? "Authenticated" : "Not authenticated"}
          </span>
        </div>
        <div className="mt-1 truncate text-[10px] text-white/42">
          {provider.modelCount} models
          {provider.supportsOauth ? " · OAuth" : ""}
          {provider.supportsApi ? " · API key" : ""}
        </div>
      </div>
      <span
        className={cn(
          "size-1.5 shrink-0",
          provider.connected ? "bg-emerald-400" : "bg-white/18"
        )}
      />
    </div>
  );
}

export function StoredCredentialRow({
  credential,
  enabled,
  onEnable,
}: {
  credential: OpencodeCredentialSummary;
  enabled: boolean;
  onEnable: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2.5 border border-white/8 bg-white/[0.025] px-2.5 py-2 text-left transition-colors hover:border-white/12 hover:bg-white/[0.05] disabled:cursor-default disabled:opacity-70"
      disabled={enabled}
      onClick={onEnable}
      type="button"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/70">
        <ProviderMark providerID={credential.id} providerName={credential.id} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[11px] text-white/88 uppercase tracking-[0.08em]">
          {credential.id}
        </div>
        <div className="mt-1 truncate text-[10px] text-white/42">
          {credential.type}
          {enabled ? " · enabled globally" : ""}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em]",
          enabled
            ? "border-emerald-400/18 bg-emerald-400/[0.08] text-emerald-200/78"
            : "border-cyan-400/18 bg-cyan-400/[0.07] text-cyan-100/78"
        )}
      >
        {enabled ? "Enabled" : "Enable"}
      </span>
    </button>
  );
}

export function SettingsActionItem({
  children,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuItem>) {
  return (
    <DropdownMenuItem
      className={cn(
        "cursor-pointer gap-2.5 rounded-xs border border-white/8 bg-white/[0.02] px-2.5 py-2 text-white/82 transition-colors focus:border-white/14 focus:bg-white/[0.06] focus:text-white data-disabled:border-white/5 data-disabled:bg-transparent data-disabled:opacity-35",
        className
      )}
      {...props}
    >
      {children}
    </DropdownMenuItem>
  );
}
