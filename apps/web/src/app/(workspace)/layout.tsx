import { AppHeader } from "@/components/app-header";
import { AuthGate } from "@/components/auth-gate";
import { ConnectionStrip } from "@/components/connection-strip";
import { PromptInput } from "@/components/prompt-input";
import { PostHogProvider } from "@/components/providers/posthog-provider";
import { ChorusWorkspaceProvider } from "@/features/workspace/provider";

/**
 * Workspace shell.
 *
 * A route group so it wraps `/` and `/help` without touching `/login`, and so
 * the session gate lives next to the provider that raises `AUTH_EXPIRED`.
 */
export default function WorkspaceLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <PostHogProvider>
      <ChorusWorkspaceProvider>
        <AuthGate>
          <AppHeader />
          <ConnectionStrip />
          <div className="flex-1 overflow-hidden">{children}</div>
          <PromptInput />
        </AuthGate>
      </ChorusWorkspaceProvider>
    </PostHogProvider>
  );
}
