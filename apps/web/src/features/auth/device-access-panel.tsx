"use client";

import { devicePairingTokenResponseSchema } from "@chorus/contracts";
import { CopyIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";

interface ActivePairingToken {
  expiresAt: number;
  token: string;
}

export function DeviceAccessPanel() {
  const [activeToken, setActiveToken] = useState<ActivePairingToken | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);

  useEffect(() => {
    if (!activeToken) {
      return;
    }

    const remaining = Math.max(0, activeToken.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setActiveToken(null);
      setMessage("This code expired. Generate another when you are ready.");
      setMessageIsError(false);
    }, remaining);

    return () => window.clearTimeout(timer);
  }, [activeToken]);

  async function generateToken() {
    if (busy) {
      return;
    }

    setBusy(true);
    setMessage(null);
    setMessageIsError(false);

    try {
      const response = await fetch("/api/auth/device-pairing", {
        cache: "no-store",
        method: "POST",
      });

      if (response.status === 401) {
        setMessage(
          "Your sign-in needs attention. Refresh Chorus and sign in again."
        );
        setMessageIsError(true);
        return;
      }
      if (!response.ok) {
        setMessage("Could not create a device code. Try again in a moment.");
        setMessageIsError(true);
        return;
      }

      const payload: unknown = await response.json();
      const parsed = devicePairingTokenResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setMessage("Chorus returned an unreadable device code. Try again.");
        setMessageIsError(true);
        return;
      }

      setActiveToken(parsed.data);
      setMessage(
        "Code ready. It can be used once and expires in five minutes."
      );
      setMessageIsError(false);
    } catch {
      setMessage("Could not reach Chorus. Check the connection and try again.");
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!activeToken) {
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(activeToken.token);
      setMessage("Code copied. Paste it on the device you are connecting.");
      setMessageIsError(false);
    } catch {
      setMessage("Clipboard unavailable. Select the code above and copy it.");
      setMessageIsError(false);
    }
  }

  let generateButtonLabel = "Generate device code";
  if (activeToken) {
    generateButtonLabel = "Generate new code";
  }
  if (busy) {
    generateButtonLabel = "Creating code…";
  }

  return (
    <section aria-label="Device access" className="space-y-3 px-1 py-3">
      <div className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center border border-white/8 bg-white/[0.03] text-white/65">
          <KeyRoundIcon className="size-3.5" />
        </span>
        <div className="space-y-1">
          <h2 className="font-medium text-[12px] text-white/88">
            Connect another device
          </h2>
          <p className="text-[11px] text-white/48 leading-relaxed">
            Create a one-time code, then enter it on the sign-in screen of the
            other device. Keep the code private.
          </p>
        </div>
      </div>

      {activeToken ? (
        <div className="space-y-2 border border-white/8 bg-black/25 p-2.5">
          <span className="sr-only">One-time device code</span>
          <code className="block select-all break-all font-mono text-[12px] text-white/90">
            {activeToken.token}
          </code>
          <button
            className="flex h-8 w-full items-center justify-center gap-2 border border-white/10 bg-white/[0.04] font-medium text-[10px] text-white/76 uppercase tracking-[0.16em] transition hover:bg-white/[0.08]"
            onClick={copyToken}
            type="button"
          >
            <CopyIcon className="size-3" />
            Copy code
          </button>
        </div>
      ) : null}

      {message ? (
        <p
          aria-live="polite"
          className={
            messageIsError
              ? "text-[10px] text-rose-300 leading-relaxed"
              : "text-[10px] text-white/52 leading-relaxed"
          }
          role={messageIsError ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}

      <button
        className="h-8 w-full border border-white/12 bg-white/[0.08] px-3 font-medium text-[10px] text-white/88 uppercase tracking-[0.16em] transition hover:bg-white/[0.12] disabled:cursor-wait disabled:opacity-50"
        disabled={busy}
        onClick={generateToken}
        type="button"
      >
        {generateButtonLabel}
      </button>
      <p className="text-[10px] text-white/34 leading-relaxed">
        Codes work once and expire after five minutes. Closing this panel hides
        the code here; generate a new one to replace it.
      </p>
    </section>
  );
}
