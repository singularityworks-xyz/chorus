"use client";

import Link from "next/link";
import { useWorkspace } from "@/features/workspace/workspace-context";

/**
 * Session gate (plan P5 task 3).
 *
 * The plan says the root layout converts `AUTH_EXPIRED` into a login-screen
 * redirect. A root layout cannot do that here: the Next.js 16 docs are explicit
 * that layouts are cached in the client during navigation and do not re-render
 * (`layout.md`: "Layouts do not rerender"), and reading cookies in a layout
 * blocks navigation with no `loading.ts` fallback. A gate inside the existing
 * provider therefore owns it, which is also where the event is emitted.
 *
 * `router.replace` rather than `push` would be the redirect form, but the plan is
 * explicit that a 401 must not retry: the reconnect loop is already stopped at
 * the source, so this only has to offer the way out.
 *
 * Note that signing back in does *not* preserve the session: `/login` lives
 * outside the `(workspace)` route group, so navigating there unmounts
 * `ChorusWorkspaceProvider` entirely. State reloads from the next snapshot
 * rather than being carried across.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { authExpired } = useWorkspace();

  if (!authExpired) {
    return children;
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-[#0a0a0a] p-6 text-white">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-white/10 bg-white/5 p-6">
        <div className="space-y-1">
          <h1 className="font-semibold text-lg">Session expired</h1>
          <p className="text-sm text-white/60">
            Chorus stopped reconnecting because the session is no longer valid.
            Sign in again to resume where you left off.
          </p>
        </div>
        <Link
          className="block w-full rounded bg-white px-3 py-2 text-center font-medium text-black text-sm"
          href="/login"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
