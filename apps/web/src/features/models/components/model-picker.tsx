"use client";

import { Popover } from "@base-ui/react/popover";
import type { ModelSelection, OpencodeModelSummary } from "@chorus/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  LoaderCircle,
  SearchIcon,
} from "lucide-react";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getProviderIconData,
  hasDedicatedProviderIconData,
} from "@/components/icons";
import { cn } from "@/lib/utils";

const SVG_TAG_REGEX = /<(path|circle|rect)\s+([^>]+?)\/>/g;
const SVG_ATTR_REGEX = /([a-z-]+)="([^"]*)"/g;
const SEARCH_TOKEN_SPLIT_REGEX = /\s+/;

export const DEFAULT_MODEL_KEY = "default";

export function createModelKey(model: ModelSelection) {
  return `${model.providerID}/${model.modelID}`;
}

interface ProviderGroup {
  connected: boolean;
  hasDedicatedIcon: boolean;
  models: OpencodeModelSummary[];
  providerID: string;
  providerName: string;
}

interface ModelPickerProps {
  allowDefaultOption?: boolean;
  availableModels: OpencodeModelSummary[];
  className?: string;
  defaultModel?: ModelSelection;
  loading?: boolean;
  onValueChange: (value: string) => void;
  previousModelSelection?: ModelSelection | null;
  recentlyUsedModels?: ModelSelection[];
  value: string;
}

interface TriggerCopy {
  label: string;
  meta: string;
}

export function ModelPicker({
  allowDefaultOption = true,
  availableModels,
  className,
  defaultModel,
  loading = false,
  onValueChange,
  previousModelSelection,
  recentlyUsedModels = [],
  value,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const providerGroups = useMemo(
    () => createProviderGroups(availableModels),
    [availableModels]
  );
  const filteredProviderGroups = useMemo(
    () => filterProviderGroups(providerGroups, deferredSearchQuery),
    [deferredSearchQuery, providerGroups]
  );
  const selectedModel = useMemo(
    () =>
      availableModels.find((model) => createModelKey(model) === value) ?? null,
    [availableModels, value]
  );
  const defaultModelSummary = useMemo(
    () => findDefaultModelSummary(availableModels, defaultModel),
    [availableModels, defaultModel]
  );
  const initialProviderID =
    selectedModel?.providerID ??
    defaultModelSummary?.providerID ??
    providerGroups[0]?.providerID ??
    "";
  const [activeProviderID, setActiveProviderID] = useState(initialProviderID);
  const hasSearchQuery = deferredSearchQuery.trim().length > 0;

  useEffect(() => {
    if (!open && searchQuery) {
      setSearchQuery("");
    }
  }, [open, searchQuery]);

  useEffect(() => {
    if (hasSearchQuery) {
      if (
        filteredProviderGroups.some(
          (group) => group.providerID === activeProviderID
        )
      ) {
        return;
      }

      setActiveProviderID(filteredProviderGroups[0]?.providerID ?? "");
      return;
    }

    if (selectedModel?.providerID) {
      setActiveProviderID(selectedModel.providerID);
      return;
    }

    if (providerGroups.some((group) => group.providerID === activeProviderID)) {
      return;
    }

    setActiveProviderID(initialProviderID);
  }, [
    activeProviderID,
    filteredProviderGroups,
    hasSearchQuery,
    initialProviderID,
    providerGroups,
    selectedModel,
  ]);

  const activeGroup = getActiveGroup(filteredProviderGroups, activeProviderID);
  const triggerCopy = getTriggerCopy({
    availableModels,
    defaultModel,
    defaultModelSummary,
    loading,
    selectedModel,
    value,
  });

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label={getTriggerAccessibleLabel({
          loading,
          selectedModel,
          triggerCopy,
          value,
        })}
        className={cn(
          "flex min-w-[13rem] max-w-[16rem] select-none items-center justify-between gap-2 rounded-xs border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          className
        )}
        suppressHydrationWarning
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex size-4 shrink-0 items-center justify-center text-white/70">
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ProviderMark
                providerID={
                  selectedModel?.providerID ??
                  defaultModelSummary?.providerID ??
                  activeGroup?.providerID
                }
                providerName={
                  selectedModel?.providerName ??
                  defaultModelSummary?.providerName ??
                  activeGroup?.providerName
                }
              />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-left text-[11px] text-white/86">
              {triggerCopy.label}
            </span>
          </span>
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-white/45" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          align="start"
          className="isolate z-50 outline-none"
          side="top"
          sideOffset={10}
        >
          <Popover.Popup className="h-[min(28rem,calc(100vh-14rem))] w-[34rem] max-w-[calc(100vw-2rem)] origin-(--transform-origin) overflow-hidden rounded-xs border border-white/10 bg-[#141414]/98 text-white shadow-[0_20px_54px_rgba(0,0,0,0.52)] ring-1 ring-white/8 backdrop-blur-xl transition-[opacity,transform] duration-100 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 sm:h-[min(28rem,calc(100vh-7rem))]">
            <div className="grid h-full min-h-0 grid-cols-[4.5rem_minmax(0,1fr)]">
              <ProviderTabs
                activeProviderID={activeGroup?.providerID}
                groups={filteredProviderGroups}
                onSelect={setActiveProviderID}
              />
              <div className="flex min-h-0 flex-col bg-[#161616]">
                <div className="border-white/6 border-b px-3 py-2">
                  {/* Desktop: description + search side by side. Mobile: search only, full width */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] text-white/35 uppercase tracking-[0.22em]">
                        Model Routing
                      </div>
                      <div className="mt-1 hidden text-[11px] text-white/48 sm:block">
                        Provider tabs reflect the models currently exposed by
                        OpenCode.
                      </div>
                    </div>
                    <label className="flex h-8 w-full shrink-0 items-center gap-2 rounded-xs border border-white/8 bg-white/[0.03] px-2.5 text-white/62 transition-colors focus-within:border-white/14 focus-within:bg-white/[0.05] focus-within:text-white/84 sm:w-[13rem]">
                      <SearchIcon className="size-3.5 shrink-0 text-white/34" />
                      <input
                        className="w-full border-0 bg-transparent p-0 text-[11px] text-white/84 outline-none placeholder:text-white/34"
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="Find models"
                        type="text"
                        value={searchQuery}
                      />
                    </label>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5">
                  {hasSearchQuery || !allowDefaultOption ? null : (
                    <DefaultModelCard
                      availableModelsCount={availableModels.length}
                      defaultModel={defaultModel}
                      defaultModelSummary={defaultModelSummary}
                      onSelect={() => {
                        onValueChange(DEFAULT_MODEL_KEY);
                        setOpen(false);
                      }}
                      selected={value === DEFAULT_MODEL_KEY}
                    />
                  )}

                  <PickerBody
                    activeGroup={activeGroup}
                    loading={loading}
                    onSelect={(nextValue) => {
                      onValueChange(nextValue);
                      setOpen(false);
                    }}
                    previousModelSelection={previousModelSelection}
                    recentModels={recentlyUsedModels}
                    searchQuery={deferredSearchQuery}
                    value={value}
                  />
                </div>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PickerBody({
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

function ProviderTabs({
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

function DefaultModelCard({
  availableModelsCount,
  defaultModel,
  defaultModelSummary,
  onSelect,
  selected,
}: {
  availableModelsCount: number;
  defaultModel?: ModelSelection;
  defaultModelSummary: OpencodeModelSummary | null;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      className={cn(
        "group flex w-full items-start gap-3 rounded-xs border px-3 py-2.5 text-left outline-none transition-colors",
        selected
          ? "border-white/14 bg-white/[0.09] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
          : "border-white/6 bg-white/[0.02] text-white/82 hover:border-white/12 hover:bg-white/[0.05] focus-visible:border-white/14 focus-visible:bg-white/[0.06]"
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-xs border border-white/8 bg-black/20 text-white/72">
        <ProviderMark providerID="opencode" providerName="OpenCode" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-[12px] text-white">
            {defaultModelSummary
              ? `Auto · ${defaultModelSummary.name}`
              : "Auto · OpenCode selection"}
          </span>
          {selected ? (
            <CheckIcon className="size-3.5 shrink-0 text-white/70" />
          ) : null}
        </span>
        <span className="mt-1 block text-[11px] text-white/42">
          {getDefaultModelMeta(defaultModel, availableModelsCount)}
        </span>
        <span className="mt-1 block text-[11px] text-white/56">
          {getDefaultModelDescription(availableModelsCount)}
        </span>
      </span>
    </button>
  );
}

function ModelOptionCard({
  model,
  onSelect,
  selected,
}: {
  model: OpencodeModelSummary;
  onSelect: (value: string) => void;
  selected: boolean;
}) {
  return (
    <button
      className={cn(
        "group flex w-full items-start gap-3 rounded-xs border px-3 py-2.5 text-left outline-none transition-colors",
        selected
          ? "border-white/14 bg-white/[0.09] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
          : "border-white/6 bg-white/[0.02] text-white/80 hover:border-white/12 hover:bg-white/[0.05] hover:text-white/92 focus-visible:border-white/14 focus-visible:bg-white/[0.06]"
      )}
      onClick={() => onSelect(createModelKey(model))}
      type="button"
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-xs border border-white/8 bg-black/20 text-white/72">
        <ProviderMark
          providerID={model.providerID}
          providerName={model.providerName}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-[12px] text-white">
            {model.name}
          </span>
          {model.status ? <StatusBadge status={model.status} /> : null}
          {selected ? (
            <CheckIcon className="ml-auto size-3.5 shrink-0 text-white/70" />
          ) : null}
        </span>
        <span className="mt-1 block truncate text-[11px] text-white/42">
          {model.providerID}/{model.modelID}
        </span>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {model.connected ? (
            <FeatureBadge label="Connected" tone="connected" />
          ) : null}
          {model.reasoning ? <FeatureBadge label="Reasoning" /> : null}
          {model.toolCall ? <FeatureBadge label="Tools" /> : null}
          {model.attachment ? <FeatureBadge label="Files" /> : null}
          {model.temperature ? <FeatureBadge label="Temp" /> : null}
        </div>
      </span>
    </button>
  );
}

function RecentlyUsedSection({
  availableModels,
  onSelect,
  previousModelSelection,
  recentModels,
  value,
}: {
  availableModels: OpencodeModelSummary[];
  onSelect: (value: string) => void;
  previousModelSelection?: ModelSelection | null;
  recentModels: ModelSelection[];
  value: string;
}) {
  const recentModelsWithDetails = recentModels
    .map((selection) => {
      const model = availableModels.find(
        (m) =>
          m.providerID === selection.providerID &&
          m.modelID === selection.modelID
      );
      return model ? { model, selection } : null;
    })
    .filter(Boolean) as {
    model: OpencodeModelSummary;
    selection: ModelSelection;
  }[];

  if (recentModelsWithDetails.length === 0) {
    return null;
  }

  const isPreviousModelSaved =
    previousModelSelection &&
    recentModels.some(
      (m) =>
        m.providerID === previousModelSelection.providerID &&
        m.modelID === previousModelSelection.modelID
    );

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="truncate text-[10px] text-white/35 uppercase tracking-[0.22em]">
          Recently Used
        </span>
        {isPreviousModelSaved && (
          <span className="rounded-xs border border-white/8 bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-white/42 uppercase tracking-[0.18em]">
            Board saved
          </span>
        )}
        <span className="h-px flex-1 bg-white/8" />
      </div>
      <div className="flex flex-col gap-1.5">
        {recentModelsWithDetails.map(({ model }) => (
          <ModelOptionCard
            key={createModelKey(model)}
            model={model}
            onSelect={onSelect}
            selected={value === createModelKey(model)}
          />
        ))}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="flex items-center gap-3 rounded-xs border border-white/6 bg-white/[0.02] px-4 py-3 text-[11px] text-white/58">
        <LoaderCircle className="size-3.5 animate-spin text-white/55" />
        Fetching models from OpenCode
      </div>
    </div>
  );
}

function EmptyState({ searchQuery }: { searchQuery: string }) {
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

function ConnectionBadge({ connected }: { connected: boolean }) {
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

function FeatureBadge({
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

function StatusBadge({
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

function ProviderMark({
  className,
  providerID,
  providerName,
}: {
  className?: string;
  providerID?: string;
  providerName?: string;
}) {
  const icon =
    getProviderIconData(providerID, providerName) ??
    getProviderIconData("opencode", "OpenCode");

  if (icon) {
    return (
      <svg
        aria-hidden="true"
        className={cn("size-4", className)}
        fill="currentColor"
        viewBox={icon.viewBox}
      >
        {renderIconBody(icon.body)}
      </svg>
    );
  }

  return null;
}

function renderIconBody(body: string) {
  const nodes: ReactNode[] = [];
  let match: RegExpExecArray | null = SVG_TAG_REGEX.exec(body);
  let index = 0;

  while (match) {
    const tag = match[1];
    const attrs = parseSvgAttributes(match[2] ?? "");

    if (tag === "path") {
      nodes.push(<path key={`path-${index}`} {...attrs} />);
    } else if (tag === "circle") {
      nodes.push(<circle key={`circle-${index}`} {...attrs} />);
    } else if (tag === "rect") {
      nodes.push(<rect key={`rect-${index}`} {...attrs} />);
    }

    index += 1;
    match = SVG_TAG_REGEX.exec(body);
  }

  SVG_TAG_REGEX.lastIndex = 0;
  return nodes;
}

function parseSvgAttributes(raw: string) {
  const props: Record<string, string> = {};
  let match: RegExpExecArray | null = SVG_ATTR_REGEX.exec(raw);

  while (match) {
    const key = match[1];
    const value = match[2];
    if (key && value !== undefined) {
      props[toSvgPropName(key)] = value;
    }
    match = SVG_ATTR_REGEX.exec(raw);
  }

  SVG_ATTR_REGEX.lastIndex = 0;
  return props;
}

function toSvgPropName(attribute: string) {
  if (attribute === "stroke-linecap") {
    return "strokeLinecap";
  }

  if (attribute === "stroke-linejoin") {
    return "strokeLinejoin";
  }

  if (attribute === "stroke-width") {
    return "strokeWidth";
  }

  if (attribute === "fill-rule") {
    return "fillRule";
  }

  if (attribute === "clip-rule") {
    return "clipRule";
  }

  return attribute;
}

function createProviderGroups(models: OpencodeModelSummary[]) {
  const groups = new Map<string, ProviderGroup>();

  for (const model of models) {
    const existing = groups.get(model.providerID);

    if (existing) {
      existing.models.push(model);
      existing.connected ||= model.connected;
      continue;
    }

    groups.set(model.providerID, {
      connected: model.connected,
      hasDedicatedIcon: hasDedicatedProviderIconData(
        model.providerID,
        model.providerName
      ),
      models: [model],
      providerID: model.providerID,
      providerName: model.providerName,
    });
  }

  return Array.from(groups.values()).sort((left, right) => {
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }

    if (left.hasDedicatedIcon !== right.hasDedicatedIcon) {
      return left.hasDedicatedIcon ? -1 : 1;
    }

    return left.providerName.localeCompare(right.providerName);
  });
}

function filterProviderGroups(groups: ProviderGroup[], searchQuery: string) {
  const normalizedQuery = normalizeSearchValue(searchQuery);
  const queryTokens = getSearchTokens(normalizedQuery);

  if (queryTokens.length === 0) {
    return groups;
  }

  return groups.flatMap((group) => {
    const providerMatches = doesSearchValueMatch(
      `${group.providerName} ${group.providerID}`,
      queryTokens
    );
    const matchingModels = providerMatches
      ? group.models
      : group.models.filter((model) => doesModelMatch(model, queryTokens));

    if (matchingModels.length === 0) {
      return [];
    }

    return [
      {
        ...group,
        models: matchingModels,
      },
    ];
  });
}

function doesModelMatch(model: OpencodeModelSummary, queryTokens: string[]) {
  return doesSearchValueMatch(
    `${model.name} ${model.modelID} ${model.providerName} ${model.providerID}`,
    queryTokens
  );
}

function doesSearchValueMatch(value: string, queryTokens: string[]) {
  const normalizedValue = normalizeSearchValue(value);

  return queryTokens.every(
    (token) =>
      normalizedValue.includes(token) ||
      isFuzzySubsequence(normalizedValue, token)
  );
}

function getSearchTokens(value: string) {
  return value.split(SEARCH_TOKEN_SPLIT_REGEX).filter(Boolean);
}

function isFuzzySubsequence(value: string, token: string) {
  if (!token) {
    return true;
  }

  let tokenIndex = 0;

  for (const character of value) {
    if (character === token[tokenIndex]) {
      tokenIndex += 1;
      if (tokenIndex === token.length) {
        return true;
      }
    }
  }

  return false;
}

function normalizeSearchValue(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[-_/.:]+/g, " ");
}

function findDefaultModelSummary(
  availableModels: OpencodeModelSummary[],
  defaultModel?: ModelSelection
) {
  if (!defaultModel) {
    return null;
  }

  return (
    availableModels.find(
      (model) =>
        model.providerID === defaultModel.providerID &&
        model.modelID === defaultModel.modelID
    ) ?? null
  );
}

function getActiveGroup(groups: ProviderGroup[], activeProviderID: string) {
  return (
    groups.find((group) => group.providerID === activeProviderID) ??
    groups[0] ??
    null
  );
}

function getTriggerCopy(input: {
  availableModels: OpencodeModelSummary[];
  defaultModel?: ModelSelection;
  defaultModelSummary: OpencodeModelSummary | null;
  loading: boolean;
  selectedModel: OpencodeModelSummary | null;
  value: string;
}): TriggerCopy {
  if (input.loading) {
    return {
      label: "Loading models...",
      meta: "Fetching provider catalog",
    };
  }

  if (input.value === DEFAULT_MODEL_KEY) {
    return {
      label: getDefaultTriggerLabel(
        input.availableModels.length,
        input.defaultModelSummary
      ),
      meta: getDefaultModelMeta(
        input.defaultModel,
        input.availableModels.length
      ),
    };
  }

  if (input.selectedModel) {
    return {
      label: input.selectedModel.name,
      meta: `${input.selectedModel.providerName} · ${input.selectedModel.providerID}/${input.selectedModel.modelID}`,
    };
  }

  return {
    label: "Choose model",
    meta: "Select a model",
  };
}

function getTriggerAccessibleLabel(input: {
  loading: boolean;
  selectedModel: OpencodeModelSummary | null;
  triggerCopy: TriggerCopy;
  value: string;
}): string {
  if (input.loading) {
    return "Choose model. Loading the model catalog.";
  }

  if (input.selectedModel) {
    return `Choose model. Current selection: ${input.selectedModel.name}, ${input.selectedModel.providerName} (${input.selectedModel.providerID}/${input.selectedModel.modelID}).`;
  }

  if (input.value === DEFAULT_MODEL_KEY) {
    return `Choose model. Current selection: ${input.triggerCopy.label}. ${input.triggerCopy.meta}.`;
  }

  if (input.value) {
    return `Choose model. Saved selection ${input.value} is unavailable.`;
  }

  return "Choose model. No model selected.";
}

function getDefaultTriggerLabel(
  availableModelsCount: number,
  defaultModelSummary: OpencodeModelSummary | null
) {
  if (defaultModelSummary) {
    return `Auto · ${defaultModelSummary.name}`;
  }

  if (availableModelsCount > 0) {
    return "Auto · OpenCode selection";
  }

  return "No models available";
}

function getDefaultModelMeta(
  defaultModel: ModelSelection | undefined,
  availableModelsCount: number
) {
  if (defaultModel) {
    return `${defaultModel.providerID}/${defaultModel.modelID}`;
  }

  if (availableModelsCount > 0) {
    return "Uses current OpenCode routing";
  }

  return "Enable a provider in OpenCode settings";
}

function getDefaultModelDescription(availableModelsCount: number) {
  if (availableModelsCount > 0) {
    return "Recommended if you want Chorus to respect the board's OpenCode default.";
  }

  return "No provider catalog was returned for this board yet.";
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
