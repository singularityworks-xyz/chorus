import { AppHeader } from "@/components/app-header";
import { AuthGate } from "@/components/auth-gate";
import { ConnectionStrip } from "@/components/connection-strip";
import { PostHogProvider } from "@/components/providers/posthog-provider";
import { PromptInput } from "@/features/composer/components/prompt-input";
import { ChorusWorkspaceProvider } from "@/features/workspace/provider";

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
