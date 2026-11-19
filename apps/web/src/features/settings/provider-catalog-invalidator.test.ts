import { describe, expect, mock, test } from "bun:test";
import { createProviderCatalogInvalidator } from "./provider-catalog-invalidator";

describe("provider catalog invalidation", () => {
  test("notifies active board consumers when Settings refreshes providers", () => {
    const invalidator = createProviderCatalogInvalidator();
    const refresh = mock(() => undefined);
    invalidator.subscribe(refresh);

    invalidator.invalidate();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("stops notifying consumers after they unsubscribe", () => {
    const invalidator = createProviderCatalogInvalidator();
    const refresh = mock(() => undefined);
    const unsubscribe = invalidator.subscribe(refresh);
    unsubscribe();

    invalidator.invalidate();

    expect(refresh).not.toHaveBeenCalled();
  });
});
