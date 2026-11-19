import type { Columns, WorkspaceColumnId } from "@chorus/contracts";
import type { AwaitingTaskActionEvent } from "../utils/task-approval-state";

export interface KanbanTaskActionState {
  awaitingEvent?: AwaitingTaskActionEvent;
  awaitingTaskCommandId?: string;
  awaitingTaskCommandStartedAt?: number;
  awaitingTaskCommandTimedOut?: boolean;
  error?: string;
  message?: string;
  pending?: "approve" | "reject" | "run" | "retry";
}

export interface KanbanCardActions {
  actionStates: Record<string, KanbanTaskActionState | undefined>;
  boardBusy: boolean;
  handleApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => Promise<void>;
  handlePlanChange: (taskId: string, plan: string) => void;
  handleQuestionsAnswered: (taskId: string, answers: string[]) => void;
  handleReject: (taskId: string) => Promise<void>;
  handleReorderTask: (
    taskId: string,
    column: WorkspaceColumnId,
    beforeTaskId: string | null
  ) => void;
  handleRetry: (taskId: string) => Promise<void>;
  handleReviewModeChange: (mode: "manual" | "auto") => Promise<void>;
  handleRun: (taskId: string) => Promise<void>;
  localColumns: Columns;
  reviewMode: "manual" | "auto";
  reviewModeError: string | null;
  reviewModePending: boolean;
}

export type SetTaskActionState = (
  taskId: string,
  state: KanbanTaskActionState | undefined
) => void;
