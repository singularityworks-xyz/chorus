"use client";

import type { HostRemoteStatus } from "@chorus/contracts";
import { useRemoteAccess } from "./use-remote-access";

const STATE_LABELS: Record<HostRemoteStatus["state"], string> = {
  disabled: "Off",
  enrolling: "Waiting for account approval",
  connecting: "Connecting",
  securing: "Securing your connection",
  ready: "Ready",
  reconnecting: "Reconnecting",
  revoked: "Access removed",
  error: "Connection needs attention",
};

const AVAILABILITY_MESSAGES: Record<
  HostRemoteStatus["availability"],
  string | null
> = {
  unconfigured: "Internet access is not configured in this installation.",
  production_required:
    "Internet access requires the installed production version of Chorus.",
  installation_error:
    "The remote connector needs repair. Your local workspace is still available.",
  available: null,
};

function AvailabilityNotice({
  availability,
}: {
  availability: HostRemoteStatus["availability"];
}) {
  const message = AVAILABILITY_MESSAGES[availability];
  return message ? (
    <p className="text-white/55" role="status">
      {message}
    </p>
  ) : null;
}

function EnrollmentApproval({
  challenge,
}: {
  challenge: NonNullable<HostRemoteStatus["challenge"]>;
}) {
  return (
    <div className="space-y-2 border border-white/10 p-2.5">
      <p className="text-white/65">
        Sign in with Google or GitHub, compare this fingerprint, then approve
        this computer.
      </p>
      <code className="block select-all break-all text-[10px] text-white/65">
        {challenge.keyFingerprint}
      </code>
      <a
        className="inline-block border border-white/12 px-3 py-2 text-white/90"
        href={challenge.verificationUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        Approve computer
      </a>
      <p className="text-white/40">
        Approval expires {new Date(challenge.expiresAt).toLocaleTimeString()}.
      </p>
    </div>
  );
}

function ConnectionStatus({ data }: { data: HostRemoteStatus | null }) {
  if (data?.availability !== "available") {
    return null;
  }
  return (
    <span
      aria-live="polite"
      className={data.state === "ready" ? "text-emerald-300" : "text-white/50"}
    >
      {STATE_LABELS[data.state]}
    </span>
  );
}

function ConnectorError({
  error,
}: {
  error: HostRemoteStatus["error"] | undefined;
}) {
  if (!error) {
    return null;
  }
  return (
    <p className="text-amber-200" role="status">
      {error === "connector_unavailable"
        ? "The connector could not start. Try resuming access; if this continues, repair your Chorus installation."
        : "The remote connection is not ready. Check internet access and account approval."}
    </p>
  );
}

export function RemoteAccessPanel() {
  const { data, error, busy, label, setLabel, copied, change, copyAddress } =
    useRemoteAccess();
  const resumable = data ? ["disabled", "error"].includes(data.state) : false;
  return (
    <section
      aria-label="Internet access"
      className="space-y-3 border-white/8 border-b pb-4 text-[11px]"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium text-[12px] text-white/88">
          Internet access
        </h3>
        <ConnectionStatus data={data} />
      </div>
      <p className="text-white/48 leading-relaxed">
        Reach this Chorus host from your phone on any network. Your work runs
        here; keep this computer awake.
      </p>
      {data ? <AvailabilityNotice availability={data.availability} /> : null}
      {data?.availability === "available" &&
      !data.enrolled &&
      !data.challenge ? (
        <div className="space-y-2">
          <label className="block text-white/60" htmlFor="remote-host-label">
            Computer name
          </label>
          <input
            className="w-full border border-white/12 bg-black/20 px-2 py-2 text-white/85"
            id="remote-host-label"
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
            value={label}
          />
          <button
            className="w-full border border-white/12 px-3 py-2 text-white/85 disabled:opacity-50"
            disabled={busy || !label.trim()}
            onClick={() => change("enrollment", { label: label.trim() })}
            type="button"
          >
            {busy ? "Preparing…" : "Enable internet access"}
          </button>
        </div>
      ) : null}
      {data?.challenge ? (
        <EnrollmentApproval challenge={data.challenge} />
      ) : null}
      {data?.publicOrigin ? (
        <div className="space-y-2 border border-emerald-400/20 p-2.5">
          <p className="text-white/60">
            Open this address on your other device, then enter a device code
            generated below.
          </p>
          <code className="block select-all break-all text-white/85">
            {data.publicOrigin}
          </code>
          <button
            className="border border-white/12 px-3 py-2 text-white/80"
            onClick={copyAddress}
            type="button"
          >
            {copied ? "Address copied" : "Copy address"}
          </button>
        </div>
      ) : null}
      {data?.enrolled ? (
        <button
          className="border border-white/12 px-3 py-2 text-white/75 disabled:opacity-50"
          disabled={busy}
          onClick={() =>
            change("connection", {
              enabled: resumable,
            })
          }
          type="button"
        >
          {resumable ? "Resume internet access" : "Pause internet access"}
        </button>
      ) : null}
      <ConnectorError error={data?.error} />
      {error ? (
        <p className="text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      {data || error ? null : (
        <p className="text-white/40" role="status">
          Checking connection…
        </p>
      )}
    </section>
  );
}
