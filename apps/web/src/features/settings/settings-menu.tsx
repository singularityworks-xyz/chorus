import { Settings } from "lucide-react";
import { useState } from "react";
import {
  sharedDropdownContentClass,
  sharedDropdownItemClass,
  sharedDropdownTriggerClass,
} from "@/components/ui/dropdown-aesthetics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
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
import {
  ProviderSettingsPanel,
  useProviderSettings,
} from "@/features/settings/provider-settings-panel";
import { isWorkspaceSessionLive } from "@/features/workspace/session-status";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { useVoiceConfig } from "@/hooks/use-voice-config";
import { cn } from "@/lib/utils";

const settingsPanelClass = cn(sharedDropdownContentClass, "w-[22rem] p-2");
const settingsSelectTriggerClass = cn(
  sharedDropdownTriggerClass,
  "h-8 w-full justify-between text-white/84"
);
const settingsSelectContentClass = sharedDropdownContentClass;
const settingsSelectItemClass = sharedDropdownItemClass;
const DEFAULT_SPEECH_VOICE_VALUE = "__default_speech_voice__";

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

export function SettingsMenu() {
  const [settingsTab, setSettingsTab] = useState<
    "devices" | "providers" | "voice"
  >("providers");

  const { preferences, sessionStatus, setSpeechVoiceId } = useWorkspace();
  const {
    defaultModelId,
    defaultVoiceId,
    isLoading: isLoadingVoiceConfig,
    voices,
  } = useVoiceConfig();

  const {
    authLoginNotice,
    configuredProviderIDs,
    connectedProviderCount,
    configureCredentialProvider,
    isLoading: isLoadingProviderStatus,
    openOpencodeAuthLogin,
    openOpencodeModels,
    providerStatus,
    providerStatusRefreshTick,
    refreshProviderStatus,
    settingsError,
    storedCredentials,
  } = useProviderSettings(isWorkspaceSessionLive(sessionStatus));
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
    providers: "One model and provider for every board",
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
        catalogRefreshToken={providerStatusRefreshTick}
        configuredProviderIDs={configuredProviderIDs}
        connectedProviderCount={connectedProviderCount}
        isLoading={isLoadingProviderStatus}
        onConfigureCredentialProvider={configureCredentialProvider}
        onOpenOpencodeAuthLogin={openOpencodeAuthLogin}
        onOpenOpencodeModels={openOpencodeModels}
        onRefreshProviderStatus={refreshProviderStatus}
        providerStatus={providerStatus}
        settingsError={settingsError}
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
                <SettingsMetric
                  label="Authenticated"
                  value={settingsError ? "—" : connectedProviderCount}
                />
                <SettingsMetric
                  label="Providers"
                  value={settingsError ? "—" : providerStatus.length}
                />
                <SettingsMetric
                  label="Stored"
                  value={settingsError ? "—" : storedCredentials.length}
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
