import {
  type PushApprovalPayload,
  pushApprovalPayloadSchema,
  type WorkspaceEvent,
} from "@chorus/contracts";

export function createApprovalPayload(
  event: Extract<WorkspaceEvent, { type: "card.waiting_for_approval" }>,
  boardTitle: string
): PushApprovalPayload | null {
  const requestId = event.requestId ?? event.pendingApproval?.requestId;
  const query = new URLSearchParams({
    board: event.boardId,
    card: event.taskId,
  }).toString();
  const parsed = pushApprovalPayloadSchema.safeParse({
    boardId: event.boardId,
    boardTitle: boardTitle.slice(0, 160),
    cardId: event.taskId,

    cardTitle:
      event.kind === "permission" ? "Permission request" : "Question request",
    kind: event.kind,
    ...(requestId ? { requestId } : {}),
    url: `/?${query}`,
    version: 1,
  });
  return parsed.success ? parsed.data : null;
}
