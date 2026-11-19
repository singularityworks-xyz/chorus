import {
  apiErrorSchema,
  queueBoardPromptResponseSchema,
} from "@chorus/contracts";
import { useCallback, useState } from "react";
import { ChorusApiError } from "@/lib/chorus-api-error";
import type { WorkspaceContextValue } from "../types";

function getModelLabel(model?: {
  modelID: string;
  providerID: string;
}): string {
  return model ? `${model.providerID}/${model.modelID}` : "OpenCode default";
}

export function usePromptActions({
  reportUnauthorized,
  selectedBoard,
}: {
  reportUnauthorized: (response: Response) => boolean;
  selectedBoard: WorkspaceContextValue["selectedBoard"];
}) {
  const [isQueueingPrompt, setIsQueueingPrompt] = useState(false);

  const queuePrompt = useCallback(
    async (
      input: Parameters<WorkspaceContextValue["queuePrompt"]>[0]
    ): ReturnType<WorkspaceContextValue["queuePrompt"]> => {
      if (!selectedBoard) {
        return null;
      }

      setIsQueueingPrompt(true);

      try {
        const response = await fetch("/api/tasks", {
          body: JSON.stringify({
            agent: input.agent,
            boardId: selectedBoard.boardId,
            directory: selectedBoard.repo.directory,
            model: input.model,
            parts: input.parts,
            projectId: selectedBoard.repo.projectId,
            reviewMode: selectedBoard.reviewMode ?? "auto",
            sessionId: selectedBoard.session.sessionId,
            text: input.text,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        if (reportUnauthorized(response)) {
          throw new Error("unauthorized");
        }

        if (!response.ok) {
          const errorPayload = apiErrorSchema.safeParse(
            await response.json().catch(() => undefined)
          );
          if (errorPayload.success) {
            throw new ChorusApiError(
              errorPayload.data.code,
              errorPayload.data.message
            );
          }
          throw new Error("prompt_request_failed");
        }

        const payload = queueBoardPromptResponseSchema.parse(
          await response.json()
        );

        // The queued event creates the card; this response only clears the composer.
        return {
          ...payload,
          task: {
            id: payload.taskId,
            label:
              selectedBoard.repo.projectName ??
              selectedBoard.repo.directory.split("/").filter(Boolean).at(-1) ??
              selectedBoard.repo.directory,
            labelVariant: "primary-light",
            run: {
              elapsed: "0m 00s",
              model: getModelLabel(input.model),
              startedAt: payload.timestamp,
              steps: [],
              taskTitle: input.text.slice(0, 96),
            },
            title: input.text.slice(0, 96),
          },
        };
      } finally {
        setIsQueueingPrompt(false);
      }
    },
    [reportUnauthorized, selectedBoard]
  );

  return { isQueueingPrompt, queuePrompt };
}
