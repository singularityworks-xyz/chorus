import type { BoardSessionHistoryCommand } from "@chorus/contracts";
import posthog from "posthog-js";
import { useCallback, useRef, useState } from "react";
import { sendBoardSessionHistoryCommand } from "@/features/kanban/board-session-history-client";
import type { WorkspaceContextValue } from "../types";

export function useSessionActions(
  reportUnauthorized: (response: Response) => boolean
) {
  const [sessionHistoryChange, setSessionHistoryChange] =
    useState<WorkspaceContextValue["sessionHistoryChange"]>(null);
  const revisionRef = useRef(0);

  const sessionCommand = useCallback(
    async (boardId: string, command: BoardSessionHistoryCommand) => {
      try {
        const result = await sendBoardSessionHistoryCommand(boardId, command, {
          onUnauthorized: reportUnauthorized,
        });

        posthog.capture("session_command_success", {
          boardId,
          command,
          sessionID: result.sessionId,
          timestamp: Date.now(),
        });
        revisionRef.current += 1;
        setSessionHistoryChange({
          boardId,
          revision: revisionRef.current,
        });

        return { ok: true };
      } catch (error) {
        posthog.capture("session_command_exception", {
          boardId,
          command,
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
        return {
          error:
            error instanceof Error
              ? error.message
              : `Could not ${command} repository changes. Check the board connection and try again.`,
          ok: false,
        };
      }
    },
    [reportUnauthorized]
  );

  return { sessionCommand, sessionHistoryChange };
}
