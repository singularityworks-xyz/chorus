"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { safeNotificationReturnTo } from "./browser";

export function NotificationFocus() {
  const { boards, focusBoardLocally, hydrated } = useWorkspace();
  const handledTarget = useRef<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || handledTarget.current) {
      return;
    }
    const target = safeNotificationReturnTo(
      window.location.pathname + window.location.search,
      window.location.origin
    );
    if (target === "/") {
      return;
    }
    handledTarget.current = target;
    const params = new URLSearchParams(target.slice(2));
    const boardId = params.get("board");
    const cardId = params.get("card");
    if (
      !(boardId && cardId && boards.some((board) => board.boardId === boardId))
    ) {
      setMessage("This approval link is no longer available.");
      return;
    }

    focusBoardLocally(boardId);
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focusCard = () => {
      const card = [
        ...document.querySelectorAll<HTMLElement>("[data-task-id]"),
      ].find(
        (element) =>
          element.dataset.taskId === cardId &&
          element.getClientRects().length > 0
      );
      if (card) {
        card.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center",
        });
        card.tabIndex = -1;
        card.focus({ preventScroll: true });
        setMessage(null);
        return;
      }
      attempts += 1;
      if (attempts >= 30) {
        setMessage(
          "This approval was resolved or removed before you opened it."
        );
        return;
      }
      timer = setTimeout(focusCard, 100);
    };
    timer = setTimeout(focusCard, 100);
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [boards, focusBoardLocally, hydrated]);

  if (!message) {
    return null;
  }
  return (
    <p
      aria-live="polite"
      className="pointer-events-none fixed top-16 left-1/2 z-50 -translate-x-1/2 rounded border border-white/10 bg-zinc-950/95 px-3 py-2 text-white/75 text-xs shadow-xl"
      role="status"
    >
      {message}
    </p>
  );
}
