"use client";

import { Popover } from "@base-ui/react/popover";
import type { ModelSelection, OpencodeModelSummary } from "@chorus/contracts";
import { ChevronDownIcon, LoaderCircle, SearchIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { DefaultModelCard } from "./components/model-cards";
import { PickerBody, ProviderTabs } from "./components/picker-content";
import { ProviderMark } from "./components/provider-mark";
import { createModelKey, DEFAULT_MODEL_KEY } from "./lib/model-key";
import {
  getTriggerAccessibleLabel,
  getTriggerCopy,
} from "./lib/model-picker-copy";
import {
  createProviderGroups,
  filterProviderGroups,
  findDefaultModelSummary,
  getActiveGroup,
} from "./lib/model-search";

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
