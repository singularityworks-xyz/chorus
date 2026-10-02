"use client";

import type { Columns } from "@chorus/contracts";
import { useEffect, useState } from "react";
import { Kanban, KanbanColumnBody } from "@/features/kanban/components/kanban";
import { useKanbanCardActions } from "@/features/kanban/hooks/use-kanban-card-actions";
import { useWorkspace } from "@/features/workspace/workspace-context";

/**
 * Phone layout (spec §9, plan P5 task 6).
 *
 * "Usable single-column phone layout — lane list view replaces freeform canvas
 * under `md`". A freeform infinite canvas is not usable on a phone: nodes are
 * positioned in world coordinates, so panning to find a board means losing the
 * approvals that matter when away from the desk.
 *
 * Lanes stack vertically at full width rather than sitting side by side in the
 * desktop board's horizontal panel group, where each column would be roughly
 * 90px wide. The lane bodies themselves are the same `KanbanColumnBody` the
 * desktop card renders, and the mutations come from the same
 * `useKanbanCardActions` hook, so a lane cannot look or behave one way on a
 * board and another way here.
 *
 * Board selection is a plain row of chips rather than a spatial gesture, and
 * whichever board is selected here is the one the composer acts on, because both
 * read the same workspace context.
 */

const LANES = ["queue", "in_progress", "approve", "done"] as const;

export function MobileLaneList() {
  const { boards, selectBoard, selectedBoardId, updateBoardColumns } =
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
      {/*
        Always present, even with a single board: it names the repository being
        looked at, and it is the one element carrying the board title regardless
        of how many boards exist. The chip row below disappears at one board, so
        without this there would be nothing identifying the board in the DOM.
      */}
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
                // Every board is listed here, unlike the card, which renders only
                // the selected one. That makes these chips the one place in the
                // UI where a client's full set of boards is present in the DOM
                // regardless of selection or canvas layout, which is what lets a
                // test assert that a client actually received a board.
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
        onUpdateColumns={updateBoardColumns}
        reviewMode={active.reviewMode ?? "auto"}
        sessionId={active.session?.sessionId}
      />
    </div>
  );
}

/**
 * The stacked lanes for one board.
 *
 * A separate component so `useKanbanCardActions` is only mounted per board: it
 * keeps optimistic columns, and switching boards should not carry the previous
 * board's state into the next one. The `key` on the call site forces the remount.
 */
function MobileBoardBody({
  boardId,
  columns,
  onUpdateColumns,
  reviewMode,
  sessionId,
}: {
  boardId: string;
  columns: Columns;
  onUpdateColumns: (boardId: string, columns: Columns) => void;
  reviewMode: "manual" | "auto";
  sessionId: string | undefined;
}) {
  const actions = useKanbanCardActions({
    boardId,
    columns,
    onUpdateColumns,
    sessionId,
  });

  // `KanbanColumnBody` reads review mode as a prop rather than owning it, so the
  // phone view has to echo the change back immediately: the mutation round trip
  // is slow enough that a toggle which appears to do nothing is
  // indistinguishable from a broken one. The server value wins once its event
  // lands, which the effect below picks up.
  const [mode, setMode] = useState<"manual" | "auto">(reviewMode);
  useEffect(() => {
    setMode(reviewMode);
  }, [reviewMode]);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto pb-24"
      data-testid="mobile-lanes"
    >
      {/*
        `Kanban` supplies the drag-and-drop context its columns read through
        `useKanbanContext`. The desktop card gets it from `KanbanCardContent`;
        rendering lane bodies directly needs its own.
      */}
      <Kanban
        getItemValue={(item) => item.id}
        id={boardId}
        onValueChange={actions.handleColumnsChange}
        value={actions.localColumns}
      >
        {LANES.map((lane) => (
          <section
            className="border-white/[0.04] border-b last:border-b-0"
            key={lane}
          >
            <KanbanColumnBody
              columnId={lane}
              onApprove={actions.handleApprove}
              onPlanChange={actions.handlePlanChange}
              onQuestionsAnswered={actions.handleQuestionsAnswered}
              onReject={actions.handleReject}
              onReviewModeChange={(nextMode) => {
                setMode(nextMode);
                actions.handleReviewModeChange(nextMode);
              }}
              reviewMode={mode}
              tasks={actions.localColumns[lane] ?? []}
            />
          </section>
        ))}
      </Kanban>
    </div>
  );
}
