export function WorkspaceActionError({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex items-center justify-center gap-3 border-rose-500/20 border-b bg-rose-500/10 px-3 py-1.5 text-center text-rose-100 text-xs"
      data-testid="workspace-action-error"
      role="alert"
    >
      <span>{message}</span>
      <button
        aria-label="Dismiss workspace action error"
        className="shrink-0 underline underline-offset-2"
        onClick={onDismiss}
        type="button"
      >
        Dismiss
      </button>
    </div>
  );
}
