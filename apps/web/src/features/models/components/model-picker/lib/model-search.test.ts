import { describe, expect, test } from "bun:test";
import type { OpencodeModelSummary } from "@chorus/contracts";
import { createProviderGroups, filterProviderGroups } from "./model-search";

function model(
  overrides: Partial<OpencodeModelSummary> = {}
): OpencodeModelSummary {
  return {
    attachment: false,
    connected: false,
    modelID: "model",
    name: "Model",
    providerID: "fixture",
    providerName: "Fixture",
    reasoning: false,
    releaseDate: "",
    temperature: false,
    toolCall: false,
    ...overrides,
  };
}

describe("model provider search", () => {
  test("groups models and orders connected providers first", () => {
    const groups = createProviderGroups([
      model({
        connected: false,
        modelID: "first",
        providerID: "alpha",
        providerName: "Alpha",
      }),
      model({
        connected: true,
        modelID: "available",
        providerID: "zeta",
        providerName: "Zeta",
      }),
      model({
        connected: true,
        modelID: "also-available",
        providerID: "zeta",
        providerName: "Zeta",
      }),
    ]);

    expect(groups.map((group) => group.providerID)).toEqual(["zeta", "alpha"]);
    expect(groups[0]?.models).toHaveLength(2);
    expect(groups[0]?.connected).toBe(true);
  });

  test("keeps only matching models when a provider name does not match", () => {
    const groups = createProviderGroups([
      model({ modelID: "alpha-v3", name: "Alpha V3" }),
      model({ modelID: "beta-v1", name: "Beta V1" }),
    ]);

    const filtered = filterProviderGroups(groups, "alpha_v3");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.models.map((item) => item.modelID)).toEqual([
      "alpha-v3",
    ]);
  });

  test("supports ordered fuzzy matches within each query token", () => {
    const groups = createProviderGroups([
      model({ modelID: "alpha-v3", name: "Alpha V3" }),
    ]);

    expect(filterProviderGroups(groups, "alh v3")[0]?.models).toHaveLength(1);
  });

  test("returns the original groups for an empty query", () => {
    const groups = createProviderGroups([model()]);

    expect(filterProviderGroups(groups, "  ")).toBe(groups);
  });
});
