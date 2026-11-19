import type { WorkspaceBoard } from "@chorus/contracts";
import { XIcon } from "lucide-react";
import Link from "next/link";
import { PushSettings } from "@/features/notifications/push-settings";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { cn } from "@/lib/utils";

type NotifType = "permission" | "question";

interface Notification {
  boardId: string;
  boardTitle: string;
  body: string;
  cardId: string;
  id: string;
  kind: NotifType;
  title: string;
}

export function getPendingNotifications(
  boards: readonly WorkspaceBoard[]
): Notification[] {
  return boards.flatMap((board) =>
    Object.values(board.columns).flatMap((tasks) =>
      tasks.flatMap((task) => {
        const pending =
          task.pendingApprovals ??
          (task.pendingApproval ? [task.pendingApproval] : []);
        return pending.map((request) => ({
          boardId: board.boardId,
          boardTitle: board.title,
          body: task.title,
          cardId: task.id,
          id:
            board.boardId +
            ":" +
            task.id +
            ":" +
            (request.requestId ?? request.kind),
          kind: request.kind,
          title:
            request.kind === "permission"
              ? "Permission needed"
              : "Answer requested",
        }));
      })
    )
  );
}
export function NotificationPane({ onClose }: { onClose: () => void }) {
  const { boards } = useWorkspace();
  const notifications = getPendingNotifications(boards);

  return (
    <div
      className={cn(
        "absolute top-[calc(100%+8px)] right-0",
        "w-[calc(100vw-1.5rem)] max-w-[360px] sm:w-[360px]",
        "overflow-hidden rounded-sm",
        "border border-white/10 bg-zinc-950/90 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
      )}
    >
      <div className="flex items-center gap-2 border-white/6 border-b px-4 py-3">
        <span className="flex-1 font-semibold text-[0.78rem] text-white/80 tracking-wide">
          Pending approvals
        </span>
        <button
          aria-label="Close notifications"
          className="flex size-6 items-center justify-center rounded-xs text-white/30 transition-colors hover:bg-white/6 hover:text-white/60"
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <PushSettings />

      <div className="max-h-[min(360px,calc(100dvh-12rem))] overflow-y-auto">
        {notifications.length === 0 ? (
          <p className="px-4 py-8 text-center text-[0.68rem] text-white/30">
            No pending approval requests.
          </p>
        ) : (
          notifications.map((notification) => {
            const target = new URLSearchParams({
              board: notification.boardId,
              card: notification.cardId,
            });
            return (
              <Link
                className="block border-white/[0.04] border-b px-4 py-3 transition-colors hover:bg-white/[0.04]"
                href={`/?${target.toString()}`}
                key={notification.id}
                onClick={onClose}
              >
                <span className="block font-medium text-[0.68rem] text-white/80">
                  {notification.title}
                </span>
                <span className="mt-1 block truncate text-[0.62rem] text-white/45">
                  {notification.body}
                </span>
                <span className="mt-1 block truncate text-[0.58rem] text-white/25">
                  {notification.boardTitle}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
