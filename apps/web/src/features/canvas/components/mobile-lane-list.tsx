"use client";

import {
  KanbanCardContent,
  type KanbanCardData,
} from "@/features/kanban/components/kanban";
import { useWorkspace } from "@/features/workspace/workspace-context";

/**
 * Phone layout (spec §9, plan P5 task 6).
 *
 * "Usable single-column phone layout — lane list view replaces freeform canvas
 * under `md`". A freeform infinite canvas is not usable on a phone: nodes are
 * positioned in world coordinates, so panning to find a board means losing the
 * approvals that matter when away from the desk.
 *
 * The lane list reuses `KanbanCardContent`, so a card on a phone is the same
 * component as a card on the canvas — approvals, steps, and actions are not a
 * second implementation that can drift.
 *
 * Board selection is a plain row of chips rather than a spatial gesture, and
 * whichever board is selected here is the one the composer acts on, because both
 * read the same workspace context.
 */

const LANES = [
  { id: "queue", label: "Queue" },
  { id: "in_progress", label: "In progress" },
  { id: "approve", label: "Approve" },
  { id: "done", label: "Done" },
] as const;

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

  const data: KanbanCardData = {
    columns: active.columns,
    id: active.boardId,
    reviewMode: active.reviewMode ?? "auto",
    title: active.title,
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
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
                key={board.boardId}
                onClick={() => {
                  selectBoard(board.boardId);
                }}
                type="button"
              >
                {board.title}
                {boardApprovals > 0 ? (
                  <span className="ml-1.5 rounded-full bg-amber-500/90 px-1.5 text-[10px] text-black">
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

      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        {/*
          Approvals are answered by `KanbanCardContent` itself, which owns the
          task-command transport. This view deliberately does not open a second
          one: a second approval path would be a second thing that can drift.
        */}
        <KanbanCardContent
          data={data}
          onColumnsChange={(columns) => {
            updateBoardColumns(active.boardId, columns);
          }}
        />

        <details className="px-4 py-3 text-white/40 text-xs">
          <summary className="cursor-pointer select-none">
            Lanes:{" "}
            {LANES.map(
              (lane) =>
                `${lane.label} ${String(active.columns[lane.id]?.length ?? 0)}`
            ).join(" · ")}
          </summary>
        </details>
      </div>
    </div>
  );
}
