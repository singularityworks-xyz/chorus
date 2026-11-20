import type { ModelSelection, OpencodeModelSummary } from "@chorus/contracts";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { createModelKey } from "../lib/model-key";
import {
  getDefaultModelDescription,
  getDefaultModelMeta,
} from "../lib/model-picker-copy";
import { FeatureBadge, StatusBadge } from "./picker-states";
import { ProviderMark } from "./provider-mark";

export function DefaultModelCard({
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

export function ModelOptionCard({
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

export function RecentlyUsedSection({
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
  const recentModelsWithDetails = recentModels.flatMap((selection) => {
    const model = availableModels.find(
      (m) =>
        m.providerID === selection.providerID && m.modelID === selection.modelID
    );
    return model ? [model] : [];
  });

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
        {recentModelsWithDetails.map((model) => (
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
