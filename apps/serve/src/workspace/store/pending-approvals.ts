import type { WorkspaceBoard, WorkspaceEvent } from "@chorus/contracts";

export type PendingApprovalActionResult<T> =
  | { status: "accepted"; value: T }
  | { status: "already_resolving" }
  | { status: "not_pending" }
  | { status: "rejected" };

export function pendingApprovalConflictMessage(
  status: "already_resolving" | "not_pending"
): string {
  return status === "already_resolving"
    ? "Another client is already responding to this request. Wait for the board to sync before trying again."
    : "This request is no longer waiting for a response. Refresh the board to see the current task state.";
}

interface PendingApprovalControllerOptions {
  commit(events: WorkspaceEvent[], boardId: string): void;
  enqueue<T>(work: () => T | Promise<T>): Promise<T>;
  getBoardBySessionId(sessionId: string): WorkspaceBoard | undefined;
}

export class PendingApprovalController {
  readonly #commit: PendingApprovalControllerOptions["commit"];
  readonly #enqueue: PendingApprovalControllerOptions["enqueue"];
  readonly #getBoardBySessionId: PendingApprovalControllerOptions["getBoardBySessionId"];
  readonly #actions = new Set<string>();

  constructor(options: PendingApprovalControllerOptions) {
    this.#commit = options.commit;
    this.#enqueue = options.enqueue;
    this.#getBoardBySessionId = options.getBoardBySessionId;
  }

  resolve(
    sessionId: string,
    requestId: string,
    resume = false
  ): Promise<boolean> {
    return this.#enqueue(() => {
      const board = this.#getBoardBySessionId(sessionId);
      const task = board ? findPendingTask(board, requestId) : undefined;
      if (!(board && task)) {
        return false;
      }

      const ts = Date.now();
      const events: WorkspaceEvent[] = [
        {
          boardId: board.boardId,
          requestId,
          taskId: task.id,
          ts,
          type: "card.approval_resolved",
        },
      ];
      const pendingApprovals =
        task.pendingApprovals ??
        (task.pendingApproval ? [task.pendingApproval] : []);
      const hasOtherPendingApprovals = pendingApprovals.some(
        (request) => request.requestId !== requestId
      );
      if (resume && !hasOtherPendingApprovals) {
        events.push({
          boardId: board.boardId,
          taskId: task.id,
          ts,
          type: "card.started",
        });
      }
      this.#commit(events, board.boardId);
      return true;
    });
  }

  async run<T>(
    sessionId: string,
    requestId: string,
    action: () => Promise<T>,
    options: {
      accepts?: (value: T) => boolean;
      resume?: boolean;
    } = {}
  ): Promise<PendingApprovalActionResult<T>> {
    const actionKey = JSON.stringify([sessionId, requestId]);
    // Claim in the write queue, then keep provider I/O outside it.
    const claim = await this.#enqueue(() => {
      if (this.#actions.has(actionKey)) {
        return "already_resolving" as const;
      }

      const board = this.#getBoardBySessionId(sessionId);
      if (!(board && findPendingTask(board, requestId, false))) {
        return "not_pending" as const;
      }

      this.#actions.add(actionKey);
      return "claimed" as const;
    });

    if (claim !== "claimed") {
      return { status: claim };
    }

    try {
      const value = await action();
      if (options.accepts && !options.accepts(value)) {
        return { status: "rejected" };
      }
      await this.resolve(sessionId, requestId, options.resume ?? false);
      return { status: "accepted", value };
    } finally {
      this.#actions.delete(actionKey);
    }
  }
}

function findPendingTask(
  board: WorkspaceBoard,
  requestId: string,
  includeLegacyAlongsideList = true
):
  | WorkspaceBoard["columns"][keyof WorkspaceBoard["columns"]][number]
  | undefined {
  return Object.values(board.columns)
    .flat()
    .find((task) => {
      const inList = task.pendingApprovals?.some(
        (request) => request.requestId === requestId
      );
      const inLegacyField = task.pendingApproval?.requestId === requestId;
      return includeLegacyAlongsideList
        ? Boolean(inList || inLegacyField)
        : (inList ?? inLegacyField ?? false);
    });
}
