import type { ReactNode } from "react";

export function ComposerDock({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="pointer-events-none fixed right-0 bottom-2 left-0 z-40 flex justify-center px-3 pb-[env(safe-area-inset-bottom)] md:bottom-8 md:px-4">
      <div className="pointer-events-none w-full max-w-3xl">
        {hint}
        {children}
      </div>
    </div>
  );
}
