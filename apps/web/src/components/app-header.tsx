"use client";

import {
  type BoardViewMode,
  type OpencodeCredentialSummary,
  type OpencodeProviderStatus,
  opencodeConfiguredProviderCatalogSchema,
  opencodeCredentialCatalogSchema,
  opencodeProviderCatalogSchema,
  type WorkspaceBoard,
} from "@chorus/contracts";
import {
  BellIcon,
  CheckCircle2Icon,
  CheckIcon,
  CpuIcon,
  FolderIcon,
  MenuIcon,
  PlugZapIcon,
  Settings,
  XIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getProviderIconData } from "@/components/icons";
import {
  sharedDropdownContentClass,
  sharedDropdownItemClass,
  sharedDropdownTriggerClass,
} from "@/components/ui/dropdown-aesthetics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DeviceAccessPanel } from "@/features/auth/device-access-panel";
import { PushSettings } from "@/features/notifications/push-settings";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { useVoiceConfig } from "@/hooks/use-voice-config";
import { cn } from "@/lib/utils";

const menuItems = ["Edit", "Window", "Help"];
const islandChrome =
  "pointer-events-auto relative rounded-sm border border-white/10 bg-zinc-950/68 shadow-[0_18px_50px_rgba(0,0,0,0.42)] backdrop-blur-2xl";
const settingsPanelClass = cn(sharedDropdownContentClass, "w-[22rem] p-2");
const settingsSelectTriggerClass = cn(
  sharedDropdownTriggerClass,
  "h-8 w-full justify-between text-white/84"
);
const settingsSelectContentClass = sharedDropdownContentClass;
const settingsSelectItemClass = sharedDropdownItemClass;
const headerMenuContentClass = cn(sharedDropdownContentClass, "min-w-72 p-1.5");
const headerSubmenuContentClass = cn(
  sharedDropdownContentClass,
  "min-w-80 p-1.5"
);
const headerMenuItemClass = cn(
  sharedDropdownItemClass,
  "focus:!text-white cursor-pointer px-3 py-2 text-sm text-white/85"
);
const headerMenuSubTriggerClass = cn(
  headerMenuItemClass,
  "data-[popup-open]:!text-white data-[popup-open]:**:!text-white data-[popup-open]:bg-white/10"
);
const headerMenuEmptyStateLabelClass = "px-3 py-2 text-[12px] text-white/40";
const headerMenuSectionLabelClass =
  "px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.2em] text-white/34";
const DEFAULT_SPEECH_VOICE_VALUE = "__default_speech_voice__";

function buildProvidersUrl(
  refreshToken: string,
  directory: string | null
): string {
  if (!directory) {
    return `/api/providers?refresh=${refreshToken}`;
  }

  return `/api/providers?refresh=${refreshToken}&directory=${encodeURIComponent(directory)}`;
}

async function fetchProviderStatus(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  return opencodeProviderCatalogSchema.parse(await response.json()).providers;
}

async function fetchStoredCredentials() {
  const response = await fetch("/api/opencode/auth-credentials", {
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  return opencodeCredentialCatalogSchema.parse(await response.json())
    .credentials;
}

async function fetchConfiguredProviders() {
  const response = await fetch("/api/opencode/configured-providers", {
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  return opencodeConfiguredProviderCatalogSchema.parse(await response.json())
    .providerIDs;
}

type NotifType = "permission" | "question";

interface Notification {
  boardId: string;
  boardTitle: string;
  body: string;
  cardId: string;
  id: string;
  kind: NotifType;
  title: string;
}

function getPendingNotifications(
  boards: readonly WorkspaceBoard[]
): Notification[] {
  return boards.flatMap((board) =>
    Object.values(board.columns).flatMap((tasks) =>
      tasks.flatMap((task) => {
        const pending =
          task.pendingApprovals ??
          (task.pendingApproval ? [task.pendingApproval] : []);
        return pending.map((request) => ({
          boardId: board.boardId,
          boardTitle: board.title,
          body: task.title,
          cardId: task.id,
          id:
            board.boardId +
            ":" +
            task.id +
            ":" +
            (request.requestId ?? request.kind),
          kind: request.kind,
          title:
            request.kind === "permission"
              ? "Permission needed"
              : "Answer requested",
        }));
      })
    )
  );
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

function SettingsMetric({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="flex min-w-0 flex-col border border-white/8 bg-white/[0.025] px-2 py-1.5">
      <span className="text-[9px] text-white/32 uppercase tracking-[0.2em]">
        {label}
      </span>
      <span className="mt-1 font-medium text-[12px] text-white/88">
        {value}
      </span>
    </div>
  );
}

function SettingsTabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex h-8 items-center justify-center border px-2.5 font-medium text-[10px] uppercase tracking-[0.18em] transition-colors",
        active
          ? "border-white/12 bg-white/[0.08] text-white"
          : "border-white/8 bg-white/[0.02] text-white/44 hover:border-white/12 hover:bg-white/[0.05] hover:text-white/76"
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function SettingsInfoCard({
  label,
  value,
  hint,
}: {
  hint?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="border border-white/8 bg-white/[0.025] px-2.5 py-2">
      <div className="text-[9px] text-white/32 uppercase tracking-[0.18em]">
        {label}
      </div>
      <div className="mt-1 truncate font-medium text-[11px] text-white/88">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-[10px] text-white/40 leading-4">{hint}</div>
      ) : null}
    </div>
  );
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
            {provider.connected ? "Live" : "Idle"}
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

async function postOpenCodeAction(path: string, directory: string) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ directory }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post ${path}`);
  }

  return response;
}

function useProviderSettings(selectedDirectory: string | null) {
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

  useEffect(() => {
    let isCancelled = false;
    const refreshToken = providerStatusRefreshTick.toString(36);

    async function loadProviderStatus() {
      try {
        const [providers, credentials, configuredProviders] = await Promise.all(
          [
            fetchProviderStatus(
              buildProvidersUrl(refreshToken, selectedDirectory)
            ),
            fetchStoredCredentials(),
            fetchConfiguredProviders(),
          ]
        );

        if (isCancelled) {
          return;
        }

        if (providers) {
          setProviderStatus(providers);
        }

        if (credentials) {
          setStoredCredentials(credentials);
        }

        if (configuredProviders) {
          setConfiguredProviderIDs(configuredProviders);
        }
      } catch (error) {
        console.error("Failed to load provider status", error);
      }
    }

    loadProviderStatus().catch((error) => {
      console.error("Failed to load provider status", error);
    });

    return () => {
      isCancelled = true;
    };
  }, [providerStatusRefreshTick, selectedDirectory]);

  return {
    authLoginNotice,
    configuredProviderIDs,
    connectedProviderCount: providerStatus.filter(
      (provider) => provider.connected
    ).length,
    providerStatus,
    refreshProviderStatus: () => {
      setProviderStatusRefreshTick((tick) => tick + 1);
    },
    async configureCredentialProvider(providerID: string) {
      const response = await fetch("/api/opencode/configure-provider", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          directory: selectedDirectory ?? undefined,
          providerID,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to configure OpenCode provider");
      }

      const payload = (await response.json()) as {
        configured: boolean;
        providerIDs?: string[];
      };

      if (payload.providerIDs) {
        setConfiguredProviderIDs(payload.providerIDs);
      }

      setAuthLoginNotice(
        `Configured ${providerID} globally for Chorus and reloaded the current board instance.`
      );
      setProviderStatusRefreshTick((tick) => tick + 1);
    },
    async openOpencodeAuthLogin() {
      if (!selectedDirectory) {
        return;
      }

      await postOpenCodeAction("/api/opencode/auth-login", selectedDirectory);
      setAuthLoginNotice(
        "Auth login completed. If no provider appears yet, enable one of the stored global credentials below for Chorus."
      );
      setProviderStatusRefreshTick((tick) => tick + 1);
    },
    async openOpencodeModels() {
      if (!selectedDirectory) {
        return;
      }

      await postOpenCodeAction("/api/opencode/models", selectedDirectory);
    },
    storedCredentials,
  };
}

function ProviderSettingsPanel({
  authLoginNotice,
  configuredProviderIDs,
  connectedProviderCount,
  providerStatus,
  selectedDirectory,
  storedCredentials,
  onConfigureCredentialProvider,
  onOpenOpencodeAuthLogin,
  onOpenOpencodeModels,
  onRefreshProviderStatus,
}: {
  authLoginNotice: string | null;
  configuredProviderIDs: string[];
  connectedProviderCount: number;
  onConfigureCredentialProvider: (providerID: string) => Promise<void>;
  onOpenOpencodeAuthLogin: () => Promise<void>;
  onOpenOpencodeModels: () => Promise<void>;
  onRefreshProviderStatus: () => void;
  providerStatus: OpencodeProviderStatus[];
  selectedDirectory: string | null;
  storedCredentials: OpencodeCredentialSummary[];
}) {
  return (
    <>
      {selectedDirectory && connectedProviderCount === 0 ? (
        <div className="mt-2 border border-amber-400/12 bg-amber-400/[0.08] px-2.5 py-2 text-[10px] text-amber-100/78 leading-4">
          No providers are active yet. Enable one of the stored credentials
          below and Chorus will reload the current board instance.
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
          {providerStatus.length === 0 ? (
            <div className="border border-white/8 bg-white/[0.025] px-2.5 py-2 text-[10px] text-white/42">
              No providers are currently loaded.
            </div>
          ) : (
            providerStatus.map((provider) => (
              <ProviderStatusRow key={provider.id} provider={provider} />
            ))
          )}
        </div>
      </div>
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
            disabled={!selectedDirectory}
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
                {selectedDirectory ?? "Select a board first"}
              </span>
            </div>
          </SettingsActionItem>
          <SettingsActionItem
            disabled={!selectedDirectory}
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
                {selectedDirectory
                  ? "Run auth login, then reload this board instance"
                  : "Select a board first"}
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

function VoiceSettingsPanel({
  defaultModelId,
  isLoadingVoiceConfig,
  resolvedSpeechVoiceValue,
  selectedSpeechVoiceLabel,
  setSpeechVoiceId,
  voices,
}: {
  defaultModelId: string | null;
  isLoadingVoiceConfig: boolean;
  resolvedSpeechVoiceValue: string;
  selectedSpeechVoiceLabel: string;
  setSpeechVoiceId: (voiceId: string | null) => void;
  voices: Array<{ gender: string; id: string; name: string }>;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      <SettingsInfoCard
        hint="Current playback voice preference in Chorus."
        label="Active voice"
        value={selectedSpeechVoiceLabel}
      />
      <div className="border border-white/8 bg-white/[0.025] px-2.5 py-2">
        <div className="text-[9px] text-white/32 uppercase tracking-[0.18em]">
          Voice
        </div>
        <div className="mt-1">
          {voices.length > 0 ? (
            <Select
              onValueChange={(value) => {
                setSpeechVoiceId(
                  value === DEFAULT_SPEECH_VOICE_VALUE ? null : value
                );
              }}
              value={resolvedSpeechVoiceValue}
            >
              <SelectTrigger className={settingsSelectTriggerClass} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                align="start"
                className={settingsSelectContentClass}
              >
                <SelectItem
                  className={settingsSelectItemClass}
                  value={DEFAULT_SPEECH_VOICE_VALUE}
                >
                  System default
                </SelectItem>
                {voices.map((voice) => (
                  <SelectItem
                    className={settingsSelectItemClass}
                    key={voice.id}
                    value={voice.id}
                  >
                    {voice.name} ({voice.gender})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="border border-white/8 bg-white/[0.03] px-2.5 py-2 text-[10px] text-white/42">
              {isLoadingVoiceConfig
                ? "Loading voice options…"
                : "Voice config is unavailable."}
            </div>
          )}
        </div>
      </div>
      <SettingsInfoCard
        hint="Current model used for microphone transcription."
        label="Speech model"
        value={defaultModelId ?? "Unavailable"}
      />
    </div>
  );
}

// ─── NotificationPane ──────────────────────────────────────────────────────────
function NotificationPane({ onClose }: { onClose: () => void }) {
  const { boards } = useWorkspace();
  const notifications = getPendingNotifications(boards);

  return (
    <div
      className={cn(
        "absolute top-[calc(100%+8px)] right-0",
        "w-[calc(100vw-1.5rem)] max-w-[360px] sm:w-[360px]",
        "overflow-hidden rounded-sm",
        "border border-white/10 bg-zinc-950/90 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
      )}
    >
      <div className="flex items-center gap-2 border-white/6 border-b px-4 py-3">
        <span className="flex-1 font-semibold text-[0.78rem] text-white/80 tracking-wide">
          Pending approvals
        </span>
        <button
          aria-label="Close notifications"
          className="flex size-6 items-center justify-center rounded-xs text-white/30 transition-colors hover:bg-white/6 hover:text-white/60"
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <PushSettings />

      <div className="max-h-[min(360px,calc(100dvh-12rem))] overflow-y-auto">
        {notifications.length === 0 ? (
          <p className="px-4 py-8 text-center text-[0.68rem] text-white/30">
            No pending approval requests.
          </p>
        ) : (
          notifications.map((notification) => {
            const target = new URLSearchParams({
              board: notification.boardId,
              card: notification.cardId,
            });
            return (
              <Link
                className="block border-white/[0.04] border-b px-4 py-3 transition-colors hover:bg-white/[0.04]"
                href={`/?${target.toString()}`}
                key={notification.id}
                onClick={onClose}
              >
                <span className="block font-medium text-[0.68rem] text-white/80">
                  {notification.title}
                </span>
                <span className="mt-1 block truncate text-[0.62rem] text-white/45">
                  {notification.body}
                </span>
                <span className="mt-1 block truncate text-[0.58rem] text-white/25">
                  {notification.boardTitle}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
// ─── MobileMenuDrawer ──────────────────────────────────────────────────────────
function MobileMenuDrawer({
  open,
  onClose,
  onOpenFolder,
  boardViewMode,
  isOpeningFolder,
  previousWorkspaces,
  recentProjects,
  createBoardFromHistory,
  createBoardFromProject,
  setBoardViewMode,
}: {
  open: boolean;
  onClose: () => void;
  onOpenFolder: () => void;
  boardViewMode: BoardViewMode;
  isOpeningFolder: boolean;
  previousWorkspaces: ReturnType<typeof useWorkspace>["previousWorkspaces"];
  recentProjects: ReturnType<typeof useWorkspace>["recentProjects"];
  createBoardFromHistory: ReturnType<
    typeof useWorkspace
  >["createBoardFromHistory"];
  createBoardFromProject: ReturnType<
    typeof useWorkspace
  >["createBoardFromProject"];
  setBoardViewMode: ReturnType<typeof useWorkspace>["setBoardViewMode"];
}) {
  // Lock body scroll while drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const allMenuItems = ["Edit", "Window", "Help"];

  return (
    <>
      {/* Backdrop — full-screen button so keyboard/SR users can also close the drawer */}
      <button
        aria-label="Close menu"
        className="fixed inset-0 z-60 cursor-default bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        type="button"
      />
      {/* Drawer panel */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-61 flex w-72 flex-col",
          "border-white/10 border-r bg-zinc-950/95 shadow-[4px_0_40px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
        )}
      >
        {/* Drawer header */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-white/8 border-b px-4">
          <Link
            aria-label="Go to Chorus home"
            className="flex items-center gap-2 rounded-xs transition-colors hover:text-white/90"
            href="/"
            onClick={onClose}
          >
            <Image
              alt="Chorus logo"
              className="h-5 w-6 invert"
              height={19}
              loading="eager"
              src="/chorus.svg"
              width={24}
            />
            <span className="select-none font-semibold text-sm text-white tracking-[0.02em]">
              Chorus
            </span>
          </Link>
          <button
            className="flex size-7 items-center justify-center rounded-xs text-white/30 transition-colors hover:bg-white/8 hover:text-white/70"
            onClick={onClose}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Drawer content */}
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {/* File section */}
          <div className="mb-1">
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              File
            </p>
            <button
              className="flex w-full items-center gap-2.5 rounded-xs px-3 py-2.5 text-sm text-white/70 transition-colors hover:bg-white/6 hover:text-white"
              onClick={() => {
                onOpenFolder();
                onClose();
              }}
              type="button"
            >
              <span className="text-white/40">
                <FolderIcon className="size-4" />
              </span>
              {isOpeningFolder ? "Opening…" : "Open Folder…"}
            </button>

            {previousWorkspaces.length > 0 && (
              <>
                <p className="mt-3 mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
                  Previous Working
                </p>
                {previousWorkspaces.map((entry) => (
                  <button
                    className="flex w-full flex-col rounded-xs px-3 py-2 transition-colors hover:bg-white/6"
                    key={entry.id}
                    onClick={() => {
                      createBoardFromHistory(entry);
                      onClose();
                    }}
                    type="button"
                  >
                    <span className="truncate font-medium text-sm text-white/85">
                      {entry.title}
                    </span>
                    <span className="truncate text-[0.67rem] text-white/35">
                      {entry.repo.directory}
                    </span>
                  </button>
                ))}
              </>
            )}

            {recentProjects.length > 0 && (
              <>
                <p className="mt-3 mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
                  Known Projects
                </p>
                {recentProjects.map((project) => (
                  <button
                    className="flex w-full flex-col rounded-xs px-3 py-2 transition-colors hover:bg-white/6"
                    key={`${project.projectId ?? project.directory}`}
                    onClick={() => {
                      createBoardFromProject(project);
                      onClose();
                    }}
                    type="button"
                  >
                    <span className="truncate font-medium text-sm text-white/85">
                      {project.projectName ??
                        project.directory.split("/").filter(Boolean).at(-1) ??
                        project.directory}
                    </span>
                    <span className="truncate text-[0.67rem] text-white/35">
                      {project.directory}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="my-1 h-px bg-white/6" />

          <div>
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              View
            </p>
            <button
              className={cn(
                "flex w-full flex-col items-start rounded-xs px-3 py-2.5 text-left transition-colors",
                boardViewMode === "stacked"
                  ? "bg-white/8 text-white"
                  : "text-white/65 hover:bg-white/6 hover:text-white"
              )}
              onClick={() => {
                setBoardViewMode("stacked");
                onClose();
              }}
              type="button"
            >
              <span className="font-medium text-sm">Stacked</span>
              <span className="text-[0.67rem] text-white/40">
                Layer boards into a card stack with visible title bars.
              </span>
            </button>
            <button
              className={cn(
                "mt-1 flex w-full flex-col items-start rounded-xs px-3 py-2.5 text-left transition-colors",
                boardViewMode === "relaxed"
                  ? "bg-white/8 text-white"
                  : "text-white/65 hover:bg-white/6 hover:text-white"
              )}
              onClick={() => {
                setBoardViewMode("relaxed");
                onClose();
              }}
              type="button"
            >
              <span className="font-medium text-sm">Relaxed</span>
              <span className="text-[0.67rem] text-white/40">
                Auto-arrange boards into a clean grid with no overlap.
              </span>
            </button>
          </div>

          <div className="my-1 h-px bg-white/6" />

          {/* Other menu items */}
          <div>
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              Menu
            </p>
            {allMenuItems.map((item) => {
              if (item === "Help") {
                return (
                  <Link
                    className="flex w-full items-center rounded-xs px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/6 hover:text-white"
                    href="/help"
                    key={item}
                    onClick={onClose}
                  >
                    {item}
                  </Link>
                );
              }
              return (
                <button
                  className="flex w-full items-center rounded-xs px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/6 hover:text-white"
                  key={item}
                  onClick={onClose}
                  type="button"
                >
                  {item}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function SettingsMenu() {
  const [settingsTab, setSettingsTab] = useState<
    "devices" | "providers" | "voice"
  >("providers");

  const { preferences, selectedBoard, setSpeechVoiceId } = useWorkspace();
  const {
    defaultModelId,
    defaultVoiceId,
    isLoading: isLoadingVoiceConfig,
    voices,
  } = useVoiceConfig();

  const selectedDirectory = selectedBoard?.repo.directory ?? null;
  const {
    authLoginNotice,
    configuredProviderIDs,
    connectedProviderCount,
    configureCredentialProvider,
    openOpencodeAuthLogin,
    openOpencodeModels,
    providerStatus,
    refreshProviderStatus,
    storedCredentials,
  } = useProviderSettings(selectedDirectory);
  const selectedSpeechVoiceId =
    preferences.speechVoiceId ?? defaultVoiceId ?? null;
  const resolvedSpeechVoiceValue =
    selectedSpeechVoiceId &&
    voices.some((voice) => voice.id === selectedSpeechVoiceId)
      ? selectedSpeechVoiceId
      : DEFAULT_SPEECH_VOICE_VALUE;
  const selectedSpeechVoiceLabel =
    voices.find((voice) => voice.id === selectedSpeechVoiceId)?.name ??
    voices.find((voice) => voice.id === defaultVoiceId)?.name ??
    selectedSpeechVoiceId ??
    "System default";
  const settingsDescriptionByTab = {
    devices: "Connect a phone or another browser",
    providers:
      selectedBoard?.repo.directory ??
      "Select a board to manage provider tools",
    voice: "Microphone and speech preferences",
  };
  const settingsTitleByTab = {
    devices: "Device access",
    providers: "Provider settings",
    voice: "Voice & Speech",
  };
  let settingsContent: React.ReactNode;
  if (settingsTab === "providers") {
    settingsContent = (
      <ProviderSettingsPanel
        authLoginNotice={authLoginNotice}
        configuredProviderIDs={configuredProviderIDs}
        connectedProviderCount={connectedProviderCount}
        onConfigureCredentialProvider={configureCredentialProvider}
        onOpenOpencodeAuthLogin={openOpencodeAuthLogin}
        onOpenOpencodeModels={openOpencodeModels}
        onRefreshProviderStatus={refreshProviderStatus}
        providerStatus={providerStatus}
        selectedDirectory={selectedDirectory}
        storedCredentials={storedCredentials}
      />
    );
  } else if (settingsTab === "voice") {
    settingsContent = (
      <VoiceSettingsPanel
        defaultModelId={defaultModelId}
        isLoadingVoiceConfig={isLoadingVoiceConfig}
        resolvedSpeechVoiceValue={resolvedSpeechVoiceValue}
        selectedSpeechVoiceLabel={selectedSpeechVoiceLabel}
        setSpeechVoiceId={setSpeechVoiceId}
        voices={voices}
      />
    );
  } else {
    settingsContent = <DeviceAccessPanel />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Settings"
        className="group relative flex h-12 w-12 items-center justify-center text-zinc-300 transition duration-300 hover:text-white"
      >
        <div className="absolute inset-[5px] rounded-none border border-white/8 bg-zinc-900/80 transition duration-300 group-hover:border-cyan-300/18 group-hover:bg-zinc-900" />
        <Settings className="relative z-10 h-4 w-4 transition duration-300 group-hover:rotate-45" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={settingsPanelClass}>
        <DropdownMenuGroup>
          <div className="border-white/6 border-b px-1 pb-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <DropdownMenuLabel className="px-0 py-0 text-[10px] text-white/32 uppercase tracking-[0.22em]">
                  Settings
                </DropdownMenuLabel>
                <div className="mt-1 font-medium text-[13px] text-white/95">
                  {settingsTitleByTab[settingsTab]}
                </div>
                <div className="mt-1 truncate text-[10px] text-white/42">
                  {settingsDescriptionByTab[settingsTab]}
                </div>
              </div>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/72">
                <Settings className="size-3.5" />
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              <SettingsTabButton
                active={settingsTab === "providers"}
                onClick={() => setSettingsTab("providers")}
              >
                Providers
              </SettingsTabButton>
              <SettingsTabButton
                active={settingsTab === "voice"}
                onClick={() => setSettingsTab("voice")}
              >
                Voice & Speech
              </SettingsTabButton>
              <SettingsTabButton
                active={settingsTab === "devices"}
                onClick={() => setSettingsTab("devices")}
              >
                Devices
              </SettingsTabButton>
            </div>
            {settingsTab === "providers" ? (
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                <SettingsMetric label="Live" value={connectedProviderCount} />
                <SettingsMetric
                  label="Providers"
                  value={providerStatus.length}
                />
                <SettingsMetric
                  label="Stored"
                  value={storedCredentials.length}
                />
              </div>
            ) : null}
          </div>

          {settingsContent}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewMenu({
  boardViewMode,
  onValueChange,
}: {
  boardViewMode: BoardViewMode;
  onValueChange: (mode: BoardViewMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="group relative shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white">
        <span className="relative z-10">View</span>
        <div className="absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className={cn(headerMenuContentClass, "min-w-88")}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className={headerMenuSectionLabelClass}>
            Board Layout
          </DropdownMenuLabel>
          <DropdownMenuItem
            className={headerMenuItemClass}
            onClick={() => onValueChange("stacked")}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium text-sm text-white/92">Stacked</span>
              <span className="text-white/42 text-xs">
                Layer boards as a deck while keeping every title bar exposed.
              </span>
            </div>
            {boardViewMode === "stacked" ? (
              <CheckIcon className="size-4 text-white/70" />
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuItem
            className={headerMenuItemClass}
            onClick={() => onValueChange("relaxed")}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium text-sm text-white/92">Relaxed</span>
              <span className="text-white/42 text-xs">
                Auto-place boards into a clean non-overlapping grid.
              </span>
            </div>
            {boardViewMode === "relaxed" ? (
              <CheckIcon className="size-4 text-white/70" />
            ) : null}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── AppHeader ─────────────────────────────────────────────────────────────────
export function AppHeader() {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  const {
    boards,
    createBoardFromHistory,
    createBoardFromProject,
    isOpeningFolder,
    openFolder,
    preferences,
    previousWorkspaces,
    recentProjects,
    setBoardViewMode,
  } = useWorkspace();

  // Close notification pane on outside click
  useEffect(() => {
    if (!notifOpen) {
      return;
    }
    function handleClick(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [notifOpen]);

  const unreadCount = getPendingNotifications(boards).length;

  return (
    <>
      {/* ── Mobile drawer ── */}
      <MobileMenuDrawer
        boardViewMode={preferences.boardViewMode}
        createBoardFromHistory={createBoardFromHistory}
        createBoardFromProject={createBoardFromProject}
        isOpeningFolder={isOpeningFolder}
        onClose={() => setMobileMenuOpen(false)}
        onOpenFolder={() => {
          openFolder().catch((error) => {
            console.error("Failed to open folder", error);
          });
        }}
        open={mobileMenuOpen}
        previousWorkspaces={previousWorkspaces}
        recentProjects={recentProjects}
        setBoardViewMode={setBoardViewMode}
      />

      <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-4">
        <div className="flex items-start justify-between gap-2 sm:gap-3">
          {/* ── Left island: logo + nav ── */}
          <div className={cn(islandChrome, "min-w-0 shrink")}>
            <div className="relative flex h-12 min-w-0 items-center gap-2 px-2">
              {/* Logo pill — always visible */}
              <Link
                aria-label="Go to Chorus home"
                className="flex shrink-0 items-center gap-2 rounded-sm border border-white/8 bg-zinc-900/78 px-3 py-2 transition-colors hover:bg-zinc-900/92"
                href="/"
              >
                <Image
                  alt="Chorus logo"
                  className="h-4.75 w-6 invert"
                  height={19}
                  loading="eager"
                  src="/chorus.svg"
                  width={24}
                />
                {/* Hide the wordmark on very small screens (<480px) */}
                <span className="hidden select-none font-medium text-sm text-white tracking-[0.01em] min-[480px]:inline">
                  Chorus
                </span>
              </Link>

              {/* ── Mobile: hamburger button ── */}
              <button
                aria-label="Open menu"
                className={cn(
                  "group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xs text-zinc-300 transition duration-300 hover:text-white sm:hidden"
                )}
                onClick={() => setMobileMenuOpen(true)}
                type="button"
              >
                <div className="absolute inset-0 rounded-xs border border-white/8 bg-zinc-900/80 opacity-0 transition duration-300 group-hover:opacity-100" />
                <MenuIcon className="relative z-10 size-4" />
              </button>

              {/* ── Desktop: divider + nav items ── */}
              <div className="hidden h-6 w-px shrink-0 bg-white/10 sm:block" />

              <nav className="hidden min-w-0 items-center gap-1 overflow-x-auto pr-1 [scrollbar-width:none] sm:flex [&::-webkit-scrollbar]:hidden">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={cn(
                      "group relative shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white"
                    )}
                  >
                    <span className="relative z-10">File</span>
                    <div className="absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className={headerMenuContentClass}>
                    <DropdownMenuItem
                      className={headerMenuItemClass}
                      onClick={() => {
                        openFolder().catch((error) => {
                          console.error("Failed to open folder", error);
                        });
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <FolderIcon className="size-4 text-white/40" />
                        <span>
                          {isOpeningFolder ? "Opening…" : "Open Folder..."}
                        </span>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-white/8" />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        className={headerMenuSubTriggerClass}
                      >
                        Previous Working
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        className={headerSubmenuContentClass}
                      >
                        {previousWorkspaces.length === 0 ? (
                          <DropdownMenuGroup>
                            <DropdownMenuLabel
                              className={headerMenuEmptyStateLabelClass}
                            >
                              No previous work yet
                            </DropdownMenuLabel>
                          </DropdownMenuGroup>
                        ) : (
                          previousWorkspaces.map((entry) => (
                            <DropdownMenuItem
                              className={headerMenuItemClass}
                              key={entry.id}
                              onClick={() => {
                                createBoardFromHistory(entry);
                              }}
                            >
                              <div className="flex min-w-0 flex-col">
                                <span className="truncate font-medium text-sm text-white/90">
                                  {entry.title}
                                </span>
                                <span className="truncate text-white/40 text-xs">
                                  {entry.repo.directory}
                                </span>
                              </div>
                            </DropdownMenuItem>
                          ))
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        className={headerMenuSubTriggerClass}
                      >
                        Known Projects
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        className={headerSubmenuContentClass}
                      >
                        {recentProjects.length === 0 ? (
                          <DropdownMenuGroup>
                            <DropdownMenuLabel
                              className={headerMenuEmptyStateLabelClass}
                            >
                              No known projects yet
                            </DropdownMenuLabel>
                          </DropdownMenuGroup>
                        ) : (
                          recentProjects.map((project) => (
                            <DropdownMenuItem
                              className={headerMenuItemClass}
                              key={`${project.projectId ?? project.directory}`}
                              onClick={() => {
                                createBoardFromProject(project);
                              }}
                            >
                              <div className="flex min-w-0 flex-col">
                                <span className="truncate font-medium text-sm text-white/90">
                                  {project.projectName ??
                                    project.directory
                                      .split("/")
                                      .filter(Boolean)
                                      .at(-1) ??
                                    project.directory}
                                </span>
                                <span className="truncate text-white/40 text-xs">
                                  {project.directory}
                                </span>
                              </div>
                            </DropdownMenuItem>
                          ))
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ViewMenu
                  boardViewMode={preferences.boardViewMode}
                  onValueChange={setBoardViewMode}
                />

                {menuItems.map((item) => {
                  const isActive = activeMenu === item;

                  if (item === "Help") {
                    return (
                      <Link
                        className={cn(
                          "group relative inline-block shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white"
                        )}
                        href="/help"
                        key={item}
                      >
                        <span className="relative z-10">{item}</span>
                        <div className="absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100" />
                      </Link>
                    );
                  }

                  return (
                    <button
                      className={cn(
                        "group relative shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white",
                        isActive && "text-white"
                      )}
                      key={item}
                      onClick={() => setActiveMenu(isActive ? null : item)}
                      onMouseEnter={() => activeMenu && setActiveMenu(item)}
                      type="button"
                    >
                      <span className="relative z-10">{item}</span>
                      <div
                        className={cn(
                          "absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100",
                          isActive &&
                            "border-cyan-300/18 bg-zinc-900 opacity-100"
                        )}
                      />
                    </button>
                  );
                })}
              </nav>
            </div>
          </div>

          {/* ── Right island: notifications + settings ── */}
          <div className={cn(islandChrome, "shrink-0")}>
            <div className="flex h-12 items-center divide-x divide-white/8">
              {/* Notification button */}
              <div className="relative" ref={notifRef}>
                <button
                  aria-label="Notifications"
                  className={cn(
                    "group relative flex h-12 w-12 items-center justify-center text-zinc-300 transition duration-300 hover:text-white",
                    notifOpen && "text-white"
                  )}
                  onClick={() => setNotifOpen((v) => !v)}
                  type="button"
                >
                  <div
                    className={cn(
                      "absolute inset-[5px] rounded-xs border bg-zinc-900/80 transition duration-300",
                      notifOpen
                        ? "border-cyan-300/18 bg-zinc-900"
                        : "border-white/8 group-hover:border-cyan-300/18 group-hover:bg-zinc-900"
                    )}
                  />
                  <BellIcon
                    className={cn(
                      "relative z-10 h-4 w-4 transition duration-300",
                      notifOpen && "text-white"
                    )}
                  />
                  {/* Unread badge */}
                  {unreadCount > 0 && (
                    <span className="absolute top-2.5 right-2.5 flex size-3.5 items-center justify-center rounded-full bg-cyan-500 font-semibold text-[0.5rem] text-white shadow-[0_0_6px_rgba(6,182,212,0.6)]">
                      {unreadCount}
                    </span>
                  )}
                </button>

                {/* Floating notification pane */}
                {notifOpen && (
                  <NotificationPane onClose={() => setNotifOpen(false)} />
                )}
              </div>

              {/* Settings button with OpenCode provider management */}
              <SettingsMenu />
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
