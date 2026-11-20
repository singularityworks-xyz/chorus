import type { ModelSelection } from "@chorus/contracts";
import { cn } from "@/lib/utils";
import { createModelKey } from "../lib/model-key";
import type { ProviderGroup } from "../lib/model-search";
import { ModelOptionCard, RecentlyUsedSection } from "./model-cards";
import { ConnectionBadge, EmptyState, LoadingState } from "./picker-states";
import { ProviderMark } from "./provider-mark";

export function PickerBody({
  activeGroup,
  loading,
  onSelect,
  previousModelSelection,
  recentModels,
  searchQuery,
  value,
}: {
  activeGroup: ProviderGroup | null;
  loading: boolean;
  onSelect: (value: string) => void;
  previousModelSelection?: ModelSelection | null;
  recentModels: ModelSelection[];
  searchQuery: string;
  value: string;
}) {
  if (loading) {
    return <LoadingState />;
  }

  if (!activeGroup) {
    return <EmptyState searchQuery={searchQuery} />;
  }

  return (
    <>
      {recentModels.length > 0 && !searchQuery ? (
        <RecentlyUsedSection
          availableModels={activeGroup.models}
          onSelect={onSelect}
          previousModelSelection={previousModelSelection}
          recentModels={recentModels}
          value={value}
        />
      ) : null}

      <div className="mt-3 flex items-center gap-2 px-1">
        <span className="truncate text-[10px] text-white/35 uppercase tracking-[0.22em]">
          {activeGroup.providerName}
        </span>
        <ConnectionBadge connected={activeGroup.connected} />
        <span className="h-px flex-1 bg-white/8" />
        <span className="text-[10px] text-white/35">
          {activeGroup.models.length} model
          {activeGroup.models.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
        <div className="flex flex-col gap-1.5">
          {activeGroup.models.map((model) => (
            <ModelOptionCard
              key={createModelKey(model)}
              model={model}
              onSelect={onSelect}
              selected={value === createModelKey(model)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

export function ProviderTabs({
  activeProviderID,
  groups,
  onSelect,
}: {
  activeProviderID?: string;
  groups: ProviderGroup[];
  onSelect: (providerID: string) => void;
}) {
  const connectedGroups = groups.filter((group) => group.connected);
  const disconnectedGroups = groups.filter((group) => !group.connected);

  return (
    <div className="flex h-full min-h-0 flex-col border-white/8 border-r bg-[#101010] px-2 py-2.5">
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto pr-0.5">
        {groups.length > 0 ? (
          <>
            {connectedGroups.map((group) => (
              <ProviderTabButton
                active={group.providerID === activeProviderID}
                group={group}
                key={group.providerID}
                onClick={() => onSelect(group.providerID)}
              />
            ))}
            {connectedGroups.length > 0 && disconnectedGroups.length > 0 ? (
              <div className="flex w-full items-center px-0.5 py-1.5">
                <div className="h-px w-full bg-white/8" />
              </div>
            ) : null}
            {disconnectedGroups.map((group) => (
              <ProviderTabButton
                active={group.providerID === activeProviderID}
                group={group}
                key={group.providerID}
                onClick={() => onSelect(group.providerID)}
              />
            ))}
          </>
        ) : (
          <div className="flex h-full items-start pt-1">
            <span className="flex h-14 w-14 items-center justify-center rounded-none border border-white/6 bg-white/[0.02] text-white/26">
              <ProviderMark providerID="opencode" providerName="OpenCode" />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderTabButton({
  active,
  group,
  onClick,
}: {
  active: boolean;
  group: ProviderGroup;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={group.providerName}
      aria-pressed={active}
      className={cn(
        "relative flex h-14 w-14 items-center justify-center rounded-none border outline-none transition-colors",
        group.connected
          ? "border-white/6 bg-white/[0.02] text-white/38 hover:border-white/12 hover:bg-white/[0.05] hover:text-white/75 focus-visible:border-white/14 focus-visible:bg-white/[0.08] focus-visible:text-white/88"
          : "border-white/4 bg-transparent text-white/16 hover:border-white/8 hover:bg-white/[0.03] hover:text-white/44 focus-visible:border-white/10 focus-visible:bg-white/[0.05] focus-visible:text-white/56",
        active &&
          (group.connected
            ? "border-white/12 bg-white/[0.08] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
            : "border-white/10 bg-white/[0.04] text-white/62")
      )}
      onClick={onClick}
      type="button"
    >
      <ProviderMark
        className="size-6"
        providerID={group.providerID}
        providerName={group.providerName}
      />
      {group.connected ? (
        <span className="absolute top-1.5 right-1.5 size-1 rounded-full bg-emerald-400/80" />
      ) : null}
      {active ? (
        <span className="absolute bottom-0 left-1/2 h-px w-5 -translate-x-1/2 bg-white/35" />
      ) : null}
    </button>
  );
}
