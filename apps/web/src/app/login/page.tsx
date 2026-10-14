"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { safeNotificationReturnTo } from "@/features/notifications/browser";

/**
 * Token entry (plan P5 task 5).
 *
 * The raw token is posted once and never stored client-side: the server answers
 * with an HttpOnly session cookie (spec §6.1), so the browser holds a credential
 * JavaScript cannot read. That is the whole reason the exchange exists.
 *
 * A failed attempt is reported without distinguishing "wrong token" from
 * "expired" — the same collapse the server makes, so the form cannot be used to
 * probe which it hit.
 */
export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        body: JSON.stringify({ token }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (response.ok) {
        // `replace` so Back does not return to a route that will 401 again.
        const requested = new URLSearchParams(window.location.search).get(
          "returnTo"
        );
        router.replace(
          safeNotificationReturnTo(requested, window.location.origin)
        );
        router.refresh();
        return;
      }

      if (response.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
        return;
      }

      setError("That token was not accepted.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-full w-full items-center justify-center bg-[#0a0a0a] p-6 text-white">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-white/10 bg-white/5 p-6"
        onSubmit={submit}
      >
        <div className="space-y-1">
          <h1 className="font-semibold text-lg">Sign in to Chorus</h1>
          <p className="text-sm text-white/60">
            Enter the access token for this Chorus instance.
          </p>
        </div>

        <details className="rounded border border-white/10 bg-black/20 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-white/80">
            Where do I find my access token?
          </summary>
          <div className="mt-3 space-y-3 text-white/60">
            <p>
              On a local development install, Chorus prints the token file path
              when it starts. By default, the file is{" "}
              <code className="break-all text-white/80">
                ~/.chorus/chorus.token
              </code>
              .
            </p>
            <p>On Windows PowerShell, read the default file with:</p>
            <code className="block break-all rounded bg-black/40 p-2 text-white/80 text-xs">
              {
                "Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.chorus\\chorus.token')"
              }
            </code>
            <p>On macOS or Linux, use:</p>
            <code className="block break-all rounded bg-black/40 p-2 text-white/80 text-xs">
              cat ~/.chorus/chorus.token
            </code>
            <p>
              If <code>DATA_DIR</code> is set, the file is inside that directory
              instead. If the instance operator configured{" "}
              <code>CHORUS_TOKEN</code>, use that configured value; the server
              does not write it to a file. For an instance on another computer,
              ask its operator for access.
            </p>
            <p>
              Keep the token private. Chorus will not store it in your browser.
            </p>
          </div>
        </details>

        <label className="block space-y-1 text-sm">
          <span className="text-white/70">Access token</span>
          <input
            autoComplete="current-password"
            autoFocus
            className="w-full rounded border border-white/15 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-white/40"
            name="token"
            onChange={(event) => setToken(event.target.value)}
            placeholder="CHORUS_TOKEN"
            type="password"
            value={token}
          />
        </label>

        {error ? (
          <p className="text-red-300 text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <button
          className="w-full rounded bg-white px-3 py-2 font-medium text-black text-sm disabled:opacity-50"
          disabled={busy || token.length === 0}
          type="submit"
        >
          {busy ? "Checking…" : "Continue"}
        </button>

        <p className="text-white/40 text-xs">
          The token is exchanged for an HttpOnly session cookie and is not kept
          in the browser.
        </p>
      </form>
    </main>
  );
}
