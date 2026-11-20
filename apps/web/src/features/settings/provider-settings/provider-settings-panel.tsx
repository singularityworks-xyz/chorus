import type {
  OpencodeCredentialSummary,
  OpencodeProviderStatus,
} from "@chorus/contracts";
import { CheckCircle2Icon, CpuIcon, PlugZapIcon } from "lucide-react";
import { GlobalModelSettings } from "@/features/settings/global-model-settings";
import {
  ProviderStatusRow,
  SettingsActionItem,
  StoredCredentialRow,
} from "./provider-settings-rows";

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
