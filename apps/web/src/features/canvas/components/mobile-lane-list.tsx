"use client";

import type { Columns } from "@chorus/contracts";
import { KanbanColumnBody } from "@/features/kanban/components/board-columns";
import { Kanban } from "@/features/kanban/components/kanban";
import { useKanbanCardActions } from "@/features/kanban/hooks/use-kanban-card-actions";
import { useWorkspace } from "@/features/workspace/workspace-context";

// Reuse desktop lanes in a vertical layout for phone screens.

const LANES = ["queue", "in_progress", "approve", "done"] as const;

export function MobileLaneList() {
  const { boards, focusBoardLocally, selectBoard, selectedBoardId } =
    useWorkspace();

  const active =
    boards.find((board) => board.boardId === selectedBoardId) ?? boards[0];

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-white/50">
        No boards yet. Open a repository to start.
      </div>
    );
  }

  const approvals = active.columns.approve?.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-white/10 border-b px-3 py-2">
        <h2
          className="truncate font-semibold text-sm text-white/90"
          data-board-title={active.title}
        >
          {active.title}
        </h2>
      </div>

      {boards.length > 1 ? (
        <div className="flex shrink-0 gap-2 overflow-x-auto border-white/10 border-b px-3 py-2">
          {boards.map((board) => {
            const isActive = board.boardId === active.boardId;
            const boardApprovals = board.columns.approve?.length ?? 0;

            return (
              <button
                className={`shrink-0 rounded-full border px-3 py-1 font-medium text-xs transition-colors ${
                  isActive
                    ? "border-white/40 bg-white/15 text-white"
                    : "border-white/10 text-white/60"
                }`}
                data-board-title={board.title}
                key={board.boardId}
                onClick={() => {
                  selectBoard(board.boardId);
                }}
                type="button"
              >
                {board.title}
                {boardApprovals > 0 ? (
                  <span className="ml-1.5 text-amber-300">
                    {boardApprovals}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {approvals > 0 ? (
        <div className="shrink-0 border-amber-500/30 border-b bg-amber-500/10 px-3 py-2 text-amber-200 text-xs">
          {approvals === 1
            ? "1 card needs your approval."
            : `${String(approvals)} cards need your approval.`}
        </div>
      ) : null}

      <MobileBoardBody
        boardId={active.boardId}
        columns={active.columns}
        key={active.boardId}
        onCreateTask={() => {
          focusBoardLocally(active.boardId);
          window.requestAnimationFrame(() => {
            document.getElementById("chorus-prompt-input")?.focus();
          });
        }}
        reviewMode={active.reviewMode ?? "auto"}
        sessionId={active.session?.sessionId}
      />
    </div>
  );
}

// Remount per board so optimistic task state cannot leak across selection.
function MobileBoardBody({
  boardId,
  columns,
  reviewMode,
  sessionId,
  onCreateTask,
}: {
  boardId: string;
  columns: Columns;
  reviewMode: "manual" | "auto";
  sessionId: string | undefined;
  onCreateTask: () => void;
}) {
  const actions = useKanbanCardActions({
    boardId,
    columns,
    reviewMode,
    sessionId,
  });

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto pb-24"
      data-testid="mobile-lanes"
    >
      <Kanban
        getItemValue={(item) => item.id}
        id={boardId}
        onReorderTask={actions.handleReorderTask}
        value={actions.localColumns}
      >
        {LANES.map((lane) => (
          <section
            className="border-white/[0.04] border-b last:border-b-0"
            key={lane}
          >
            <KanbanColumnBody
              actionStates={actions.actionStates}
              boardBusy={actions.boardBusy}
              boardId={boardId}
              columnId={lane}
              onApprove={actions.handleApprove}
              onCreateTask={onCreateTask}
              onPlanChange={actions.handlePlanChange}
              onQuestionsAnswered={actions.handleQuestionsAnswered}
              onReject={actions.handleReject}
              onRetry={actions.handleRetry}
              onReviewModeChange={actions.handleReviewModeChange}
              onRun={actions.handleRun}
              reviewMode={actions.reviewMode}
              reviewModeError={actions.reviewModeError}
              reviewModePending={actions.reviewModePending}
              tasks={actions.localColumns[lane] ?? []}
            />
          </section>
        ))}
      </Kanban>
    </div>
  );
}
