import type { ModelSelection, OpencodeModelSummary } from "@chorus/contracts";
import { DEFAULT_MODEL_KEY } from "./model-key";

export interface TriggerCopy {
  label: string;
  meta: string;
}

export function getTriggerCopy(input: {
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

export function getTriggerAccessibleLabel(input: {
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

export function getDefaultModelMeta(
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

export function getDefaultModelDescription(availableModelsCount: number) {
  if (availableModelsCount > 0) {
    return "Recommended if you want Chorus to respect the board's OpenCode default.";
  }

  return "No provider catalog was returned for this board yet.";
}
