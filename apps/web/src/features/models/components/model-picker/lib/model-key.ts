import type { ModelSelection } from "@chorus/contracts";

export const DEFAULT_MODEL_KEY = "default";

export function createModelKey(model: ModelSelection) {
  return `${model.providerID}/${model.modelID}`;
}
