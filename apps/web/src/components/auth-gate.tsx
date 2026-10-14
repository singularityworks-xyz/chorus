"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { safeNotificationReturnTo } from "@/features/notifications/browser";
import { useWorkspace } from "@/features/workspace/workspace-context";

/**
 * The root layout cannot react to AUTH_EXPIRED because Next.js layouts are
 * cached during client navigation. This gate sits inside the provider that
 * receives the event and can preserve the current board/card target.
 *
 * Serve deliberately returns the same unauthorized result for missing,
 * expired, and invalid sessions. Keep the copy neutral instead of claiming the
 * user had a session that expired. The sync layer already stops retrying a
 * rejected session; this gate provides the sign-in path.
 *
 * Do not mount the canvas until a saved or server snapshot is available. That
 * prevents an empty workspace from being mistaken for successfully loaded
 * state while the initial connection is still being resolved.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { authExpired, connectionError, hydrated, sessionStatus } =
    useWorkspace();
  const [returnTo, setReturnTo] = useState("/");

  useEffect(() => {
    const target = safeNotificationReturnTo(
      window.location.pathname + window.location.search,
      window.location.origin
    );
    setReturnTo(target);

    if (authExpired) {
      router.replace(`/login?returnTo=${encodeURIComponent(target)}`);
    }
  }, [authExpired, router]);

  if (authExpired) {
    return (
      <main className="flex h-full w-full items-center justify-center bg-[#0a0a0a] p-6 text-white">
        <section
          aria-live="polite"
          className="w-full max-w-sm space-y-4 rounded-lg border border-white/10 bg-white/5 p-6"
          role="status"
        >
          <div className="space-y-1">
            <h1 className="font-semibold text-lg">Sign in to Chorus</h1>
            <p className="text-sm text-white/60">
              Enter a device code from a signed-in Chorus device, or the server
              access token supplied by its operator.
            </p>
          </div>
          <Link
            className="block w-full rounded bg-white px-3 py-2 text-center font-medium text-black text-sm"
            href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
          >
            Continue to sign in
          </Link>
        </section>
      </main>
    );
  }

  if (hydrated) {
    return children;
  }

  let detail = "Waiting for Chorus to load your workspace…";
  if (connectionError) {
    detail = connectionError;
  } else if (sessionStatus === "offline") {
    detail = "Trying to reconnect to Chorus…";
  }

  return (
    <main
      aria-live="polite"
      className="flex h-full w-full items-center justify-center bg-[#0a0a0a] p-6 text-white"
      role="status"
    >
      <section className="w-full max-w-sm space-y-3 rounded-lg border border-white/10 bg-white/5 p-6 text-center">
        <h1 className="font-semibold text-lg">Loading your workspace</h1>
        <p className="text-sm text-white/60">{detail}</p>
        {connectionError ? (
          <button
            className="rounded bg-white px-3 py-2 font-medium text-black text-sm"
            onClick={() => window.location.reload()}
            type="button"
          >
            Try again
          </button>
        ) : null}
      </section>
    </main>
  );
}
