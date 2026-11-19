"use client";

import { DiffFloatingWindow } from "@chorus/monaco";
import type { Node, NodeProps } from "@xyflow/react";
import { memo, useCallback } from "react";
import { DiffNotice } from "@/features/kanban/components/diff-notice";
import { KanbanCardContent } from "@/features/kanban/components/kanban-card-content";
import { useKanbanCardActions } from "@/features/kanban/task-actions/use-kanban-card-actions";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { cn } from "@/lib/utils";
import { inferDiffLanguage } from "./diff-language";
import type { KanbanCardNodeData } from "./node-data";
import { KanbanCardNodeHeader } from "./node-header";
import { useBoardDiffs } from "./use-board-diffs";
import { useGitStatus } from "./use-git-status";

function focusBoardPrompt(
  boardId: string,
  focusBoardLocally: (boardId: string) => void
) {
  focusBoardLocally(boardId);
  window.requestAnimationFrame(() => {
    document.getElementById("chorus-prompt-input")?.focus();
  });
}

function KanbanCardNodeComponent({
  data: cardData,
  draggable,
  id,
  selected,
}: NodeProps<Node<KanbanCardNodeData>>) {
  const filePath = cardData.filePath ?? cardData.projectName ?? cardData.title;
  const gitStatusState = useGitStatus(filePath, cardData.gitStatus);
  const diffState = useBoardDiffs(cardData.sessionId);
  const { focusBoardLocally } = useWorkspace();
  const {
    actionStates,
    boardBusy,
    handleApprove,
    handleReorderTask,
    handlePlanChange,
    handleQuestionsAnswered,
    handleReject,
    handleRetry,
    handleRun,
    handleReviewModeChange,
    reviewMode,
    reviewModeError,
    reviewModePending,
  } = useKanbanCardActions({
    boardId: cardData.boardId,
    columns: cardData.columns,
    reviewMode: cardData.reviewMode ?? "auto",
    sessionId: cardData.sessionId,
  });

  const handleCreateTask = useCallback(() => {
    focusBoardPrompt(cardData.boardId, focusBoardLocally);
  }, [cardData.boardId, focusBoardLocally]);

  return (
    <>
      <div
        className={cn(
          "dark flex h-full w-full flex-col overflow-hidden rounded-sm border border-white/10 bg-[#111111]/95 shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl transition-[box-shadow,border-color,background-color] duration-500",
          selected
            ? "border-white/16 shadow-[0_32px_100px_rgba(0,0,0,0.74)]"
            : "active:shadow-[0_32px_100px_rgba(0,0,0,0.8)] active:ring-1 active:ring-white/15"
        )}
      >
        <KanbanCardNodeHeader
          boardBusy={boardBusy}
          data={cardData}
          diffFiles={diffState.diffFiles}
          draggable={draggable}
          gitStatus={gitStatusState.gitStatus}
          gitStatusError={gitStatusState.error}
          isLoadingDiff={diffState.isLoadingDiff}
          isLoadingGitStatus={gitStatusState.loading}
          onRemove={() => cardData.onRemove(id)}
          onRetryGitStatus={gitStatusState.refresh}
          onSelectDiffFile={diffState.handleSelectDiffFile}
          onViewDiffs={diffState.handleViewDiffs}
        />

        <DiffNotice
          error={diffState.diffError}
          notice={diffState.diffNotice}
          onRetry={diffState.handleViewDiffs}
          retrying={diffState.isLoadingDiff}
        />

        <div className="nodrag flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 min-w-0 flex-1 p-4">
            <KanbanCardContent
              actionStates={actionStates}
              boardBusy={boardBusy}
              data={{
                id: cardData.boardId,
                title: cardData.title,
                columns: cardData.columns,
                reviewMode,
              }}
              onApprove={handleApprove}
              onCreateTask={handleCreateTask}
              onPlanChange={handlePlanChange}
              onQuestionsAnswered={handleQuestionsAnswered}
              onReject={handleReject}
              onReorderTask={handleReorderTask}
              onRetry={handleRetry}
              onReviewModeChange={handleReviewModeChange}
              onRun={handleRun}
              reviewModeError={reviewModeError}
              reviewModePending={reviewModePending}
            />
          </div>
        </div>
      </div>

      <DiffFloatingWindow
        language={inferDiffLanguage(
          diffState.selectedDiffFile?.file ?? filePath
        )}
        modified={diffState.selectedDiffFile?.after ?? ""}
        onClose={diffState.handleCloseDiff}
        original={diffState.selectedDiffFile?.before ?? ""}
        visible={diffState.diffVisible}
      />
    </>
  );
}

export const KanbanCardNode = memo(KanbanCardNodeComponent);
