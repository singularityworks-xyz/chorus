import type { ModelSelection, OpencodeModelSummary } from "@chorus/contracts";
import { hasDedicatedProviderIconData } from "@/components/icons";

const SEARCH_TOKEN_SPLIT_REGEX = /\s+/;

export interface ProviderGroup {
  connected: boolean;
  hasDedicatedIcon: boolean;
  models: OpencodeModelSummary[];
  providerID: string;
  providerName: string;
}

export function createProviderGroups(models: OpencodeModelSummary[]) {
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

export function filterProviderGroups(
  groups: ProviderGroup[],
  searchQuery: string
) {
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

export function findDefaultModelSummary(
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

export function getActiveGroup(
  groups: ProviderGroup[],
  activeProviderID: string
) {
  return (
    groups.find((group) => group.providerID === activeProviderID) ??
    groups[0] ??
    null
  );
}
