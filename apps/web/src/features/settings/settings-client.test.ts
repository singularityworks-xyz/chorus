import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchGlobalModelCatalog,
  fetchProviderStatus,
  modelSettingsLoadErrorMessage,
  providerSettingsLoadErrorMessage,
} from "./settings-client";

const originalFetch = globalThis.fetch;

function replaceFetch(
  handler: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => Promise<Response>
): void {
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      handler(input, init),
    { preconnect: originalFetch.preconnect }
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Settings catalog requests", () => {
  test("loads global provider status with a bounded signal", async () => {
    let requestSignal: AbortSignal | null | undefined;
    replaceFetch((_input, init) => {
      requestSignal = init?.signal;
      return Promise.resolve(Response.json({ providers: [] }));
    });

    await expect(fetchProviderStatus("/api/providers")).resolves.toEqual([]);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);
  });

  test("refreshes the shared model catalog and validates its payload", async () => {
    let requestedUrl = "";
    replaceFetch((input) => {
      requestedUrl = String(input);
      return Promise.resolve(Response.json({ models: [] }));
    });

    await expect(
      fetchGlobalModelCatalog(new AbortController().signal, 4)
    ).resolves.toEqual({ models: [] });
    expect(requestedUrl).toBe("/api/models?refresh=4");
  });

  test("turns catalog deadlines into recoverable Settings messages", () => {
    const timeout = new DOMException("Timed out", "TimeoutError");

    expect(providerSettingsLoadErrorMessage(timeout)).toBe(
      "Loading provider settings timed out. Retry."
    );
    expect(modelSettingsLoadErrorMessage(timeout)).toBe(
      "Loading available models timed out. Retry."
    );
  });
});
