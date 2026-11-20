import type {
  Task,
  WorkspaceBoard,
  WorkspaceColumnId,
} from "@chorus/contracts";
import type { KanbanTaskActionState } from "../task-actions/types";

type ReviewMode = NonNullable<WorkspaceBoard["reviewMode"]>;

export interface KanbanColumnProps {
  actionStates?: Record<string, KanbanTaskActionState | undefined>;
  boardBusy: boolean;
  boardId: string;
  columnId: WorkspaceColumnId;
  onApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => void | Promise<void>;
  onCreateTask: () => void;
  onPlanChange: (taskId: string, plan: string) => void;
  onQuestionsAnswered: (taskId: string, answers: string[]) => void;
  onReject: (taskId: string) => void | Promise<void>;
  onRetry: (taskId: string) => void | Promise<void>;
  onReviewModeChange: (mode: ReviewMode) => void;
  onRun: (taskId: string) => void | Promise<void>;
  reviewMode: ReviewMode;
  reviewModeError: string | null;
  reviewModePending: boolean;
  tasks: Task[];
}

export type KanbanTaskListProps = Pick<
  KanbanColumnProps,
  | "actionStates"
  | "boardBusy"
  | "boardId"
  | "columnId"
  | "onApprove"
  | "onPlanChange"
  | "onQuestionsAnswered"
  | "onReject"
  | "onRetry"
  | "onRun"
  | "reviewMode"
  | "tasks"
>;
