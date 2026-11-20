import type { Task } from "@chorus/contracts";
import { requireAcceptedCommand } from "../command-client";

const TASK_ACTION_TIMEOUT_MS = 10_000;

type TaskActionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export function taskPendingApprovals(task: Task) {
  return (
    task.pendingApprovals ??
    (task.pendingApproval ? [task.pendingApproval] : [])
  );
}

export async function submitTaskApproval(
  {
    answers,
    boardId,
    plan,
    sessionId,
    task,
  }: {
    answers: string[];
    boardId: string;
    plan: string;
    sessionId?: string;
    task: Task;
  },
  fetcher: TaskActionFetch = fetch
): Promise<void> {
  const taskSessionId = task.run?.sessionId ?? task.runId ?? sessionId;
  const pendingApprovals = taskPendingApprovals(task);
  const permission = pendingApprovals.find(
    (entry) => entry.kind === "permission"
  );
  if (permission) {
    if (!permission.requestId) {
      throw new Error(
        "This permission request has expired. Refresh the board to load the latest request."
      );
    }
    if (!taskSessionId) {
      throw new Error(
        "This permission request has no provider session. Refresh the board and try again."
      );
    }
    await requireAcceptedCommand(
      await fetcher(`/api/tasks/${encodeURIComponent(taskSessionId)}/approve`, {
        body: JSON.stringify({ requestID: permission.requestId }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
      }),
      {
        fallback: "Could not approve this permission request. Try again.",
      }
    );
    return;
  }

  if (pendingApprovals.some((entry) => entry.kind === "question")) {
    throw new Error(
      "Answer the pending question in this card before continuing."
    );
  }
  if (task.outcome !== "awaiting_review") {
    throw new Error(
      "No active approval request was found. Refresh the board and try again."
    );
  }

  const planText = plan || task.plan || task.title;
  await requireAcceptedCommand(
    await fetcher(
      `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(task.id)}/finalize-review`,
      {
        body: JSON.stringify({ answers, plan: planText }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
      }
    ),
    {
      fallback:
        "Could not finalize this plan. Your edits are still on the card; try again.",
    }
  );
}

export async function submitTaskRejection(
  {
    boardId,
    sessionId,
    task,
  }: {
    boardId: string;
    sessionId?: string;
    task: Task;
  },
  fetcher: TaskActionFetch = fetch
): Promise<void> {
  const taskSessionId = task.run?.sessionId ?? task.runId ?? sessionId;
  const pendingApprovals = taskPendingApprovals(task);
  const permission = pendingApprovals.find(
    (entry) => entry.kind === "permission"
  );
  if (permission) {
    if (!permission.requestId) {
      throw new Error(
        "This permission request has expired. Refresh the board to load the latest request."
      );
    }
    if (!taskSessionId) {
      throw new Error(
        "This permission request has no provider session. Refresh the board and try again."
      );
    }
    await requireAcceptedCommand(
      await fetcher(`/api/tasks/${encodeURIComponent(taskSessionId)}/reject`, {
        body: JSON.stringify({ requestID: permission.requestId }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
      }),
      { fallback: "Could not reject this permission request. Try again." }
    );
    return;
  }

  const question = pendingApprovals.find((entry) => entry.kind === "question");
  if (question?.requestId) {
    if (!taskSessionId) {
      throw new Error(
        "This question has no provider session. Refresh the board and try again."
      );
    }
    await requireAcceptedCommand(
      await fetcher(
        `/api/tasks/${encodeURIComponent(taskSessionId)}/questions/${encodeURIComponent(question.requestId)}/reject`,
        {
          method: "POST",
          signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
        }
      ),
      { fallback: "Could not reject this question. Try again." }
    );
    return;
  }
  if (task.outcome !== "awaiting_review") {
    throw new Error(
      "No active request was found to reject. Refresh the board and try again."
    );
  }

  await requireAcceptedCommand(
    await fetcher(
      `/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(task.id)}/reject-review`,
      {
        method: "POST",
        signal: AbortSignal.timeout(TASK_ACTION_TIMEOUT_MS),
      }
    ),
    {
      fallback:
        "Could not reject this plan. Your task remains on the board; try again.",
    }
  );
}
