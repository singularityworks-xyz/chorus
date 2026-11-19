import { describe, expect, mock, test } from "bun:test";
import { ProviderManager } from "./provider-manager";

const providers = {
  all: [
    {
      id: "anthropic",
      models: {
        sonnet: {
          capabilities: {
            attachment: true,
            reasoning: true,
            temperature: true,
            toolcall: true,
          },
          id: "sonnet",
          name: "Sonnet",
          release_date: "2025-01-01",
        },
      },
      name: "Anthropic",
    },
  ],
  connected: ["anthropic"],
  default: { anthropic: "sonnet" },
};

function createManager({
  apiAuthResponse = { data: true },
  authResponse = { data: { anthropic: [{ type: "api" }, { type: "oauth" }] } },
  callbackResponse = { data: true },
  oauthAuthorizeResponse = {
    data: {
      instructions: "Continue in browser",
      method: "code",
      url: "https://example.test",
    },
  },
  providerResponse = { data: providers },
}: {
  apiAuthResponse?: unknown;
  authResponse?: unknown;
  callbackResponse?: unknown;
  oauthAuthorizeResponse?: unknown;
  providerResponse?: unknown;
} = {}) {
  const providerList = mock(() => Promise.resolve(providerResponse));
  const providerAuth = mock(() => Promise.resolve(authResponse));
  const oauthAuthorize = mock(() => Promise.resolve(oauthAuthorizeResponse));
  const oauthCallback = mock(() => Promise.resolve(callbackResponse));
  const setAuth = mock(() => Promise.resolve(apiAuthResponse));
  const manager = new ProviderManager({
    auth: { set: setAuth },
    provider: {
      auth: providerAuth,
      list: providerList,
      oauth: {
        authorize: oauthAuthorize,
        callback: oauthCallback,
      },
    },
  } as never);

  return {
    manager,
    calls: {
      oauthAuthorize,
      oauthCallback,
      providerAuth,
      providerList,
      setAuth,
    },
  };
}

describe("ProviderManager failure handling", () => {
  test("normalizes provider and authentication catalogs", async () => {
    const { manager } = createManager();

    await expect(manager.listProviders()).resolves.toEqual({
      providers: [
        {
          connected: true,
          id: "anthropic",
          modelCount: 1,
          name: "Anthropic",
          supportsApi: true,
          supportsOauth: true,
        },
      ],
    });
  });

  test("provider list errors are not turned into an empty model catalog", async () => {
    const { manager } = createManager({
      providerResponse: { error: { code: "ServiceUnavailable" } },
    });

    await expect(manager.listModels()).rejects.toThrow(
      "OpenCode provider.list failed (ServiceUnavailable)"
    );
  });

  test("provider authentication lookup errors are not hidden", async () => {
    const { manager } = createManager({
      authResponse: { error: { code: "Unauthorized" } },
    });

    await expect(manager.listProviders()).rejects.toThrow(
      "OpenCode provider.auth failed (Unauthorized)"
    );
  });

  test("an auth-method failure is not returned as an empty method list", async () => {
    const { manager } = createManager({
      authResponse: { error: { code: "Forbidden" } },
    });

    await expect(
      manager.getAuthMethods({ providerID: "anthropic" })
    ).rejects.toThrow("OpenCode provider.auth failed (Forbidden)");
  });

  test("OAuth callback and API-auth errors are not returned as false", async () => {
    const callback = createManager({
      callbackResponse: { error: { code: "BadRequest" } },
    });
    const apiAuth = createManager({
      apiAuthResponse: { error: { code: "Unauthorized" } },
    });

    await expect(
      callback.manager.completeOauth({
        code: "oauth-code",
        method: 0,
        providerID: "anthropic",
      })
    ).rejects.toThrow("OpenCode provider.oauth.callback failed (BadRequest)");
    await expect(
      apiAuth.manager.setApiAuth({
        key: "api-key",
        providerID: "anthropic",
      })
    ).rejects.toThrow("OpenCode auth.set failed (Unauthorized)");
  });

  test("returns explicit provider rejection values when the SDK has no error", async () => {
    const { manager, calls } = createManager({
      apiAuthResponse: { data: false },
      callbackResponse: { data: false },
    });

    await expect(
      manager.completeOauth({
        code: "oauth-code",
        method: 0,
        providerID: "anthropic",
      })
    ).resolves.toBe(false);
    await expect(
      manager.setApiAuth({ key: "api-key", providerID: "anthropic" })
    ).resolves.toBe(false);
    expect(calls.oauthCallback).toHaveBeenCalledTimes(1);
    expect(calls.setAuth).toHaveBeenCalledTimes(1);
  });
});
