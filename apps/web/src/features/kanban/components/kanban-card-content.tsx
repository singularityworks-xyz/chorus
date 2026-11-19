"use client";

import type { WorkspaceColumnId } from "@chorus/contracts";
import { Fragment } from "react";
import {
  ResizableHandle,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { KanbanTaskActionState } from "@/features/kanban/hooks/use-kanban-card-actions";
import type { KanbanCardData } from "../types";
import { KanbanColumnRenderer } from "./board-columns";
import { Kanban, KanbanBoard } from "./kanban";

export function KanbanCardContent({
  data,
  actionStates,
  boardBusy,
  reviewModeError,
  reviewModePending,
  onReorderTask,
  onReviewModeChange,
  onApprove,
  onReject,
  onPlanChange,
  onQuestionsAnswered,
  onRetry,
  onRun,
  onCreateTask,
}: {
  data: KanbanCardData;
  actionStates?: Record<string, KanbanTaskActionState | undefined>;
  boardBusy: boolean;
  reviewModeError: string | null;
  reviewModePending: boolean;
  onReorderTask: (
    taskId: string,
    column: WorkspaceColumnId,
    beforeTaskId: string | null
  ) => void;
  onReviewModeChange: (mode: "manual" | "auto") => void | Promise<void>;
  onApprove: (
    taskId: string,
    plan: string,
    answers: string[]
  ) => void | Promise<void>;
  onReject: (taskId: string) => void | Promise<void>;
  onRetry: (taskId: string) => void | Promise<void>;
  onRun: (taskId: string) => void | Promise<void>;
  onCreateTask: () => void;
  onPlanChange: (taskId: string, plan: string) => void;
  onQuestionsAnswered: (taskId: string, answers: string[]) => void;
}) {
  const reviewMode = data.reviewMode ?? "auto";

  return (
    <Kanban
      getItemValue={(item) => item.id}
      id={data.id}
      onReorderTask={onReorderTask}
      value={data.columns}
    >
      <KanbanBoard className="flex h-full min-h-0 w-full min-w-0">
        <ResizablePanelGroup
          className="relative w-full flex-1"
          direction="horizontal"
        >
          {Object.entries(data.columns).map(([columnId, tasks], index, arr) => (
            <Fragment key={columnId}>
              <KanbanColumnRenderer
                actionStates={actionStates}
                boardBusy={boardBusy}
                boardId={data.id}
                columnId={columnId}
                onApprove={onApprove}
                onCreateTask={onCreateTask}
                onPlanChange={onPlanChange}
                onQuestionsAnswered={onQuestionsAnswered}
                onReject={onReject}
                onRetry={onRetry}
                onReviewModeChange={onReviewModeChange}
                onRun={onRun}
                reviewMode={reviewMode}
                reviewModeError={reviewModeError}
                reviewModePending={reviewModePending}
                tasks={tasks}
              />
              {index < arr.length - 1 && <ResizableHandle withHandle />}
            </Fragment>
          ))}
        </ResizablePanelGroup>
      </KanbanBoard>
    </Kanban>
  );
}
