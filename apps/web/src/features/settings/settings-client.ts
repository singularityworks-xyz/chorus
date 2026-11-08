import {
  opencodeConfiguredProviderCatalogSchema,
  opencodeConfigureProviderResponseSchema,
  opencodeCredentialCatalogSchema,
  opencodeModelCatalogSchema,
  opencodeProviderCatalogSchema,
} from "@chorus/contracts";

const SETTINGS_REQUEST_TIMEOUT_MS = 10_000;

function settingsRequestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function providerSettingsLoadErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Loading provider settings timed out. Retry.";
  }
  return "Could not load provider settings. Check the engine connection and retry.";
}

export function modelSettingsLoadErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Loading available models timed out. Retry.";
  }
  return "Could not load available models. Check the engine connection and retry.";
}

export async function fetchProviderStatus(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: settingsRequestSignal(signal),
  });

  if (!response.ok) {
    throw new Error(`provider_status_http_${String(response.status)}`);
  }

  return opencodeProviderCatalogSchema.parse(await response.json()).providers;
}

export async function fetchStoredCredentials(signal?: AbortSignal) {
  const response = await fetch("/api/opencode/auth-credentials", {
    cache: "no-store",
    signal: settingsRequestSignal(signal),
  });

  if (!response.ok) {
    throw new Error(`provider_credentials_http_${String(response.status)}`);
  }

  return opencodeCredentialCatalogSchema.parse(await response.json())
    .credentials;
}

export async function fetchConfiguredProviders(signal?: AbortSignal) {
  const response = await fetch("/api/opencode/configured-providers", {
    cache: "no-store",
    signal: settingsRequestSignal(signal),
  });

  if (!response.ok) {
    throw new Error(`configured_providers_http_${String(response.status)}`);
  }

  return opencodeConfiguredProviderCatalogSchema.parse(await response.json())
    .providerIDs;
}

export async function configureOpenCodeProvider(providerID: string) {
  const response = await fetch("/api/opencode/configure-provider", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ providerID }),
    signal: settingsRequestSignal(),
  });

  if (!response.ok) {
    throw new Error(`provider_configure_http_${String(response.status)}`);
  }

  return opencodeConfigureProviderResponseSchema.parse(await response.json());
}

export async function postOpenCodeAction(path: string): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
    signal: settingsRequestSignal(),
  });

  if (!response.ok) {
    throw new Error(`Failed to post ${path}`);
  }

  const payload: unknown = await response.json();
  return payload;
}

export async function fetchGlobalModelCatalog(
  signal: AbortSignal,
  refreshKey: number
) {
  const refreshQuery = refreshKey > 0 ? `?refresh=${refreshKey}` : "";
  const response = await fetch(`/api/models${refreshQuery}`, {
    cache: "no-store",
    signal: settingsRequestSignal(signal),
  });
  if (!response.ok) {
    throw new Error("model_catalog_unavailable");
  }
  return opencodeModelCatalogSchema.parse(await response.json());
}
