"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
        router.replace("/");
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
          <h1 className="font-semibold text-lg">Chorus</h1>
          <p className="text-sm text-white/60">
            Enter your access token to continue.
          </p>
        </div>

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
