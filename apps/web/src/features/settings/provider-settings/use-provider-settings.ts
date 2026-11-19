import {
  type OpencodeCredentialSummary,
  type OpencodeProviderStatus,
  opencodeAuthLoginResponseSchema,
  opencodeModelsDialogResponseSchema,
} from "@chorus/contracts";
import { useEffect, useState } from "react";
import { providerCatalogInvalidator } from "../provider-catalog-invalidator";
import {
  configureOpenCodeProvider,
  fetchConfiguredProviders,
  fetchProviderStatus,
  fetchStoredCredentials,
  postOpenCodeAction,
  providerSettingsLoadErrorMessage,
} from "../settings-client";

function buildProvidersUrl(refreshToken: string): string {
  return `/api/providers?refresh=${refreshToken}`;
}

export function useProviderSettings(isSessionLive: boolean) {
  const [providerStatus, setProviderStatus] = useState<
    OpencodeProviderStatus[]
  >([]);
  const [storedCredentials, setStoredCredentials] = useState<
    OpencodeCredentialSummary[]
  >([]);
  const [configuredProviderIDs, setConfiguredProviderIDs] = useState<string[]>(
    []
  );
  const [providerStatusRefreshTick, setProviderStatusRefreshTick] = useState(0);
  const [authLoginNotice, setAuthLoginNotice] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isSessionLive) {
      return;
    }

    let isCancelled = false;
    const controller = new AbortController();
    const refreshToken = providerStatusRefreshTick.toString(36);

    async function loadProviderStatus() {
      setIsLoading(true);
      setSettingsError(null);
      try {
        const [providers, credentials, configuredProviders] = await Promise.all(
          [
            fetchProviderStatus(
              buildProvidersUrl(refreshToken),
              controller.signal
            ),
            fetchStoredCredentials(controller.signal),
            fetchConfiguredProviders(controller.signal),
          ]
        );

        if (isCancelled) {
          return;
        }

        setProviderStatus(providers);
        setStoredCredentials(credentials);
        setConfiguredProviderIDs(configuredProviders);
      } catch (error) {
        if (isCancelled) {
          return;
        }
        console.error("Failed to load provider status", error);
        controller.abort();
        setSettingsError(providerSettingsLoadErrorMessage(error));
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    loadProviderStatus();

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [isSessionLive, providerStatusRefreshTick]);

  return {
    authLoginNotice,
    configuredProviderIDs,
    isLoading,
    providerStatusRefreshTick,
    settingsError,
    connectedProviderCount: providerStatus.filter(
      (provider) => provider.connected
    ).length,
    providerStatus,
    refreshProviderStatus: () => {
      providerCatalogInvalidator.invalidate();
      setProviderStatusRefreshTick((tick) => tick + 1);
    },
    async configureCredentialProvider(providerID: string) {
      try {
        const payload = await configureOpenCodeProvider(providerID);
        setConfiguredProviderIDs(payload.providerIDs);
        setAuthLoginNotice(
          `Enabled ${providerID} in global OpenCode settings.`
        );
        setSettingsError(null);
        providerCatalogInvalidator.invalidate();
        setProviderStatusRefreshTick((tick) => tick + 1);
      } catch (error) {
        setSettingsError(
          "Could not enable this provider. Check its credentials and retry."
        );
        throw error;
      }
    },
    async openOpencodeAuthLogin() {
      let response: ReturnType<typeof opencodeAuthLoginResponseSchema.parse>;
      try {
        response = opencodeAuthLoginResponseSchema.parse(
          await postOpenCodeAction("/api/opencode/auth-login")
        );
      } catch (error) {
        setSettingsError(
          "Could not start provider authentication on this host."
        );
        throw error;
      }
      if (!response.launched) {
        setSettingsError(
          "This host could not open provider authentication. Enable a stored credential or use OpenCode on the host."
        );
        return;
      }
      setSettingsError(null);
      setAuthLoginNotice(
        "Auth login completed. If no provider appears yet, enable one of the stored global credentials below for Chorus."
      );
      providerCatalogInvalidator.invalidate();
      setProviderStatusRefreshTick((tick) => tick + 1);
    },
    async openOpencodeModels() {
      let response: ReturnType<typeof opencodeModelsDialogResponseSchema.parse>;
      try {
        response = opencodeModelsDialogResponseSchema.parse(
          await postOpenCodeAction("/api/opencode/models")
        );
      } catch (error) {
        setSettingsError("Could not open the host model selector.");
        throw error;
      }
      if (!response.opened) {
        setSettingsError(
          "The host model selector is unavailable. Choose an available model from Settings instead."
        );
        return;
      }
      setSettingsError(null);
    },
    storedCredentials,
  };
}
