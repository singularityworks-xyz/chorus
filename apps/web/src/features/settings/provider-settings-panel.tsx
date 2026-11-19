import {
  type OpencodeCredentialSummary,
  type OpencodeProviderStatus,
  opencodeAuthLoginResponseSchema,
  opencodeModelsDialogResponseSchema,
} from "@chorus/contracts";
import { CheckCircle2Icon, CpuIcon, PlugZapIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { getProviderIconData } from "@/components/icons";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { GlobalModelSettings } from "@/features/settings/global-model-settings";
import { providerCatalogInvalidator } from "@/features/settings/provider-catalog-invalidator";
import {
  configureOpenCodeProvider,
  fetchConfiguredProviders,
  fetchProviderStatus,
  fetchStoredCredentials,
  postOpenCodeAction,
  providerSettingsLoadErrorMessage,
} from "@/features/settings/settings-client";
import { cn } from "@/lib/utils";

function buildProvidersUrl(refreshToken: string): string {
  return `/api/providers?refresh=${refreshToken}`;
}
function ProviderMark({
  providerID,
  providerName,
  className,
}: {
  className?: string;
  providerID?: string;
  providerName?: string;
}) {
  const iconData =
    getProviderIconData(providerID, providerName) ??
    getProviderIconData("opencode", "OpenCode");

  if (!iconData) {
    return null;
  }

  const paths = Array.from(iconData.body.matchAll(/<path\s+([^>]*?)\/?>/g));

  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 fill-current", className)}
      viewBox={iconData.viewBox}
    >
      {paths.map((match) => (
        <path
          key={`${iconData.name}-${match[1] ?? ""}`}
          {...parseSvgPathAttributes(match[1] ?? "")}
        />
      ))}
    </svg>
  );
}

function parseSvgPathAttributes(
  source: string
): React.SVGProps<SVGPathElement> {
  const attributes: Record<string, string> = {};

  for (const match of source.matchAll(/([:\w-]+)="([^"]*)"/g)) {
    const [, rawName, value] = match;
    if (!(rawName && value !== undefined)) {
      continue;
    }

    const normalizedName = rawName.replace(/-([a-z])/g, (_, char: string) =>
      char.toUpperCase()
    );
    attributes[normalizedName] = value;
  }

  return attributes;
}

function ProviderStatusRow({ provider }: { provider: OpencodeProviderStatus }) {
  return (
    <div className="flex items-center gap-2.5 border border-white/8 bg-white/[0.025] px-2.5 py-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/70">
        <ProviderMark providerID={provider.id} providerName={provider.name} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-[11px] text-white/88 uppercase tracking-[0.08em]">
            {provider.name}
          </span>
          <span
            className={cn(
              "shrink-0 border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em]",
              provider.connected
                ? "border-emerald-400/18 bg-emerald-400/[0.08] text-emerald-200/78"
                : "border-white/8 bg-white/[0.04] text-white/38"
            )}
          >
            {provider.connected ? "Authenticated" : "Not authenticated"}
          </span>
        </div>
        <div className="mt-1 truncate text-[10px] text-white/42">
          {provider.modelCount} models
          {provider.supportsOauth ? " · OAuth" : ""}
          {provider.supportsApi ? " · API key" : ""}
        </div>
      </div>
      <span
        className={cn(
          "size-1.5 shrink-0",
          provider.connected ? "bg-emerald-400" : "bg-white/18"
        )}
      />
    </div>
  );
}

function StoredCredentialRow({
  credential,
  enabled,
  onEnable,
}: {
  credential: OpencodeCredentialSummary;
  enabled: boolean;
  onEnable: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2.5 border border-white/8 bg-white/[0.025] px-2.5 py-2 text-left transition-colors hover:border-white/12 hover:bg-white/[0.05] disabled:cursor-default disabled:opacity-70"
      disabled={enabled}
      onClick={onEnable}
      type="button"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/70">
        <ProviderMark providerID={credential.id} providerName={credential.id} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[11px] text-white/88 uppercase tracking-[0.08em]">
          {credential.id}
        </div>
        <div className="mt-1 truncate text-[10px] text-white/42">
          {credential.type}
          {enabled ? " · enabled globally" : ""}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em]",
          enabled
            ? "border-emerald-400/18 bg-emerald-400/[0.08] text-emerald-200/78"
            : "border-cyan-400/18 bg-cyan-400/[0.07] text-cyan-100/78"
        )}
      >
        {enabled ? "Enabled" : "Enable"}
      </span>
    </button>
  );
}

function SettingsActionItem({
  children,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuItem>) {
  return (
    <DropdownMenuItem
      className={cn(
        "cursor-pointer gap-2.5 rounded-xs border border-white/8 bg-white/[0.02] px-2.5 py-2 text-white/82 transition-colors focus:border-white/14 focus:bg-white/[0.06] focus:text-white data-disabled:border-white/5 data-disabled:bg-transparent data-disabled:opacity-35",
        className
      )}
      {...props}
    >
      {children}
    </DropdownMenuItem>
  );
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

export function ProviderSettingsPanel({
  authLoginNotice,
  configuredProviderIDs,
  connectedProviderCount,
  isLoading,
  catalogRefreshToken,
  providerStatus,
  settingsError,
  storedCredentials,
  onConfigureCredentialProvider,
  onOpenOpencodeAuthLogin,
  onOpenOpencodeModels,
  onRefreshProviderStatus,
}: {
  authLoginNotice: string | null;
  configuredProviderIDs: string[];
  connectedProviderCount: number;
  isLoading: boolean;
  catalogRefreshToken: number;
  onConfigureCredentialProvider: (providerID: string) => Promise<void>;
  onOpenOpencodeAuthLogin: () => Promise<void>;
  onOpenOpencodeModels: () => Promise<void>;
  onRefreshProviderStatus: () => void;
  providerStatus: OpencodeProviderStatus[];
  settingsError: string | null;
  storedCredentials: OpencodeCredentialSummary[];
}) {
  return (
    <>
      {!(isLoading || settingsError) && connectedProviderCount === 0 ? (
        <div className="mt-2 border border-amber-400/12 bg-amber-400/[0.08] px-2.5 py-2 text-[10px] text-amber-100/78 leading-4">
          No providers are authenticated yet. Enable a stored credential or
          authenticate a provider here.
        </div>
      ) : null}
      {settingsError ? (
        <div
          className="mt-2 flex items-start justify-between gap-2 border border-rose-400/15 bg-rose-400/[0.06] px-2.5 py-2"
          role="alert"
        >
          <span className="text-[10px] text-rose-100/85 leading-4">
            {settingsError}
          </span>
          <button
            className="shrink-0 text-[10px] text-rose-100 underline underline-offset-2"
            onClick={onRefreshProviderStatus}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}
      {authLoginNotice ? (
        <div className="mt-2 border border-cyan-400/12 bg-cyan-400/[0.07] px-2.5 py-2 text-[10px] text-cyan-100/78 leading-4">
          {authLoginNotice}
        </div>
      ) : null}
      <div className="mt-2">
        <div className="px-1 text-[10px] text-white/32 uppercase tracking-[0.2em]">
          Providers
        </div>
        <div className="mt-1 flex max-h-52 flex-col gap-1 overflow-y-auto pr-0.5">
          {isLoading ? (
            <div
              aria-live="polite"
              className="border border-white/8 bg-white/[0.025] px-2.5 py-2 text-[10px] text-white/42"
            >
              Loading provider status…
            </div>
          ) : null}
          {!(isLoading || settingsError) && providerStatus.length === 0 ? (
            <div className="border border-white/8 bg-white/[0.025] px-2.5 py-2 text-[10px] text-white/42">
              No providers are currently loaded.
            </div>
          ) : null}
          {!isLoading && providerStatus.length > 0
            ? providerStatus.map((provider) => (
                <ProviderStatusRow key={provider.id} provider={provider} />
              ))
            : null}
        </div>
      </div>
      <GlobalModelSettings key={catalogRefreshToken} />
      {storedCredentials.length > 0 ? (
        <div className="mt-2 border-white/6 border-t pt-2">
          <div className="px-1 text-[10px] text-white/32 uppercase tracking-[0.2em]">
            Stored Credentials
          </div>
          <div className="mt-1 flex max-h-44 flex-col gap-1 overflow-y-auto pr-0.5">
            {storedCredentials.map((credential) => (
              <StoredCredentialRow
                credential={credential}
                enabled={configuredProviderIDs.includes(credential.id)}
                key={credential.id}
                onEnable={() => {
                  onConfigureCredentialProvider(credential.id).catch(
                    (error) => {
                      console.error(
                        "Failed to configure stored credential",
                        error
                      );
                    }
                  );
                }}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-2 border-white/6 border-t pt-2">
        <div className="px-1 text-[10px] text-white/32 uppercase tracking-[0.2em]">
          Actions
        </div>
        <div className="mt-1 flex flex-col gap-1">
          <SettingsActionItem
            onClick={() => {
              onOpenOpencodeModels().catch((error) => {
                console.error("Failed to open OpenCode models", error);
              });
            }}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/62">
              <CpuIcon className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="text-[11px] uppercase tracking-[0.08em]">
                Open model selector
              </span>
              <span className="truncate text-[10px] text-white/40">
                Configure models for every board
              </span>
            </div>
          </SettingsActionItem>
          <SettingsActionItem
            onClick={() => {
              onOpenOpencodeAuthLogin().catch((error) => {
                console.error("Failed to launch auth login", error);
              });
            }}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/62">
              <PlugZapIcon className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="text-[11px] uppercase tracking-[0.08em]">
                Launch auth login
              </span>
              <span className="truncate text-[10px] text-white/40">
                Authenticate a provider for every board
              </span>
            </div>
          </SettingsActionItem>
          <SettingsActionItem onClick={onRefreshProviderStatus}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/62">
              <CheckCircle2Icon className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="text-[11px] uppercase tracking-[0.08em]">
                Refresh provider status
              </span>
              <span className="truncate text-[10px] text-white/40">
                Recheck connections and available models
              </span>
            </div>
          </SettingsActionItem>
        </div>
      </div>
    </>
  );
}
