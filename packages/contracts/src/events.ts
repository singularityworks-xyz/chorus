import { z } from "zod";
import {
  agentStepSchema,
  boardViewModeSchema,
  columnsSchema,
  modelSelectionSchema,
  reviewModeSchema,
  taskSchema,
  workspaceBoardSchema,
  workspaceBoardSessionSchema,
} from "./base";

/**
 * The four fixed kanban lanes (spec §2). `columnsSchema` is a loose record for
 * forward compatibility, but every transition in the vocabulary names one of
 * these explicitly so the projector never has to guess a lane.
 */
export const WORKSPACE_COLUMN_IDS = [
  "queue",
  "in_progress",
  "approve",
  "done",
] as const;

export const workspaceColumnIdSchema = z.enum(WORKSPACE_COLUMN_IDS);

export type WorkspaceColumnId = z.infer<typeof workspaceColumnIdSchema>;

/** Snapshot blob version. Bump when a persisted shape changes incompatibly. */
export const WORKSPACE_SNAPSHOT_VERSION = 1;

/**
 * Every event carries the timestamp it was appended at. The projector derives
 * run elapsed time from this rather than `Date.now()`, which keeps
 * `applyEventToBoard` a pure, deterministic function (spec §4 determinism
 * requirement; the pre-Phase-1 projector read the wall clock).
 */
const workspaceEventBaseSchema = z.object({
  ts: z.number().int().nonnegative(),
});

const boardScopedSchema = workspaceEventBaseSchema.extend({
  boardId: z.string().min(1),
});

/**
 * Why a card moved to `approve`. Kept explicit so the UI and the push payload
 * (spec §10) can describe the request without re-deriving it.
 */
export const approvalRequestKindSchema = z.enum(["permission", "question"]);

export type ApprovalRequestKind = z.infer<typeof approvalRequestKindSchema>;

// ── Board lifecycle ─────────────────────────────────────────────────────────

export const boardCreatedEventSchema = workspaceEventBaseSchema.extend({
  board: workspaceBoardSchema,
  boardId: z.string().min(1),
  type: z.literal("board.created"),
});

export const boardMovedEventSchema = boardScopedSchema.extend({
  position: z.object({ x: z.number(), y: z.number() }),
  type: z.literal("board.moved"),
});

export const boardRemovedEventSchema = boardScopedSchema.extend({
  type: z.literal("board.removed"),
});

/** Workspace-scoped: selecting a board is not a property of one board. */
export const boardSelectedEventSchema = workspaceEventBaseSchema.extend({
  boardId: z.string().min(1).nullable(),
  type: z.literal("board.selected"),
});

export const boardReviewModeSetEventSchema = boardScopedSchema.extend({
  reviewMode: reviewModeSchema,
  type: z.literal("board.review_mode_set"),
});

export const boardModelSetEventSchema = boardScopedSchema.extend({
  model: modelSelectionSchema.nullable(),
  type: z.literal("board.model_set"),
});

export const boardColumnsReplacedEventSchema = boardScopedSchema.extend({
  columns: columnsSchema,
  type: z.literal("board.columns_replaced"),
});

export const boardSessionPatchedEventSchema = boardScopedSchema.extend({
  session: workspaceBoardSessionSchema.partial(),
  type: z.literal("board.session_patched"),
});

export const boardTaskPlanUpdatedEventSchema = boardScopedSchema.extend({
  plan: z.string(),
  questions: z.array(z.string()).optional(),
  taskId: z.string().min(1),
  type: z.literal("board.task_plan_updated"),
});

// ── Card lifecycle ──────────────────────────────────────────────────────────

export const cardCreatedEventSchema = boardScopedSchema.extend({
  column: workspaceColumnIdSchema,
  task: taskSchema,
  taskId: z.string().min(1),
  type: z.literal("card.created"),
});

export const cardQueuedEventSchema = boardScopedSchema.extend({
  column: workspaceColumnIdSchema.default("queue"),
  task: taskSchema.optional(),
  taskId: z.string().min(1),
  type: z.literal("card.queued"),
});

export const cardStartedEventSchema = boardScopedSchema.extend({
  taskId: z.string().min(1),
  type: z.literal("card.started"),
});

export const cardMovedEventSchema = boardScopedSchema.extend({
  column: workspaceColumnIdSchema,
  taskId: z.string().min(1),
  type: z.literal("card.moved"),
});

export const cardWaitingForApprovalEventSchema = boardScopedSchema.extend({
  kind: approvalRequestKindSchema,
  requestId: z.string().min(1).optional(),
  taskId: z.string().min(1),
  type: z.literal("card.waiting_for_approval"),
});

export const cardCompletedEventSchema = boardScopedSchema.extend({
  taskId: z.string().min(1),
  type: z.literal("card.completed"),
});

export const cardFailedEventSchema = boardScopedSchema.extend({
  error: z.string().optional(),
  taskId: z.string().min(1),
  type: z.literal("card.failed"),
});

// ── Run / step ──────────────────────────────────────────────────────────────

export const runStartedEventSchema = boardScopedSchema.extend({
  model: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  startedAt: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  taskTitle: z.string().min(1),
  type: z.literal("run.started"),
});

export const stepUpsertedEventSchema = boardScopedSchema.extend({
  step: agentStepSchema,
  taskId: z.string().min(1),
  type: z.literal("step.upserted"),
});

export const stepDeltaAppendedEventSchema = boardScopedSchema.extend({
  delta: z.string(),
  stepId: z.string().min(1),
  taskId: z.string().min(1),
  type: z.literal("step.delta_appended"),
});

// ── Session ─────────────────────────────────────────────────────────────────

export const sessionAttachedEventSchema = boardScopedSchema.extend({
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  type: z.literal("session.attached"),
});

export const sessionIdleEventSchema = boardScopedSchema.extend({
  type: z.literal("session.idle"),
});

export const sessionErrorEventSchema = boardScopedSchema.extend({
  error: z.string().optional(),
  taskId: z.string().min(1).optional(),
  type: z.literal("session.error"),
});

export const sessionTimeoutEventSchema = boardScopedSchema.extend({
  error: z.string().optional(),
  taskId: z.string().min(1).optional(),
  type: z.literal("session.timeout"),
});

export const sessionStartingEventSchema = boardScopedSchema.extend({
  type: z.literal("session.starting"),
});

// ── Preferences (workspace-scoped) ───────────────────────────────────────────

export const preferenceRecentModelAddedEventSchema =
  workspaceEventBaseSchema.extend({
    model: modelSelectionSchema,
    type: z.literal("preference.recent_model_added"),
  });

export const preferenceComposerHintDismissedEventSchema =
  workspaceEventBaseSchema.extend({
    type: z.literal("preference.composer_hint_dismissed"),
  });

export const preferenceSpeechVoiceSetEventSchema =
  workspaceEventBaseSchema.extend({
    voiceId: z.string().min(1).nullable(),
    type: z.literal("preference.speech_voice_set"),
  });

export const preferenceBoardViewModeSetEventSchema =
  workspaceEventBaseSchema.extend({
    mode: boardViewModeSchema,
    type: z.literal("preference.board_view_mode_set"),
  });

// ── Union ───────────────────────────────────────────────────────────────────

export const workspaceEventSchema = z.discriminatedUnion("type", [
  boardCreatedEventSchema,
  boardMovedEventSchema,
  boardRemovedEventSchema,
  boardSelectedEventSchema,
  boardReviewModeSetEventSchema,
  boardModelSetEventSchema,
  boardColumnsReplacedEventSchema,
  boardSessionPatchedEventSchema,
  boardTaskPlanUpdatedEventSchema,
  cardCreatedEventSchema,
  cardQueuedEventSchema,
  cardStartedEventSchema,
  cardMovedEventSchema,
  cardWaitingForApprovalEventSchema,
  cardCompletedEventSchema,
  cardFailedEventSchema,
  runStartedEventSchema,
  stepUpsertedEventSchema,
  stepDeltaAppendedEventSchema,
  sessionAttachedEventSchema,
  sessionStartingEventSchema,
  sessionIdleEventSchema,
  sessionErrorEventSchema,
  sessionTimeoutEventSchema,
  preferenceRecentModelAddedEventSchema,
  preferenceComposerHintDismissedEventSchema,
  preferenceSpeechVoiceSetEventSchema,
  preferenceBoardViewModeSetEventSchema,
]);

export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
export type WorkspaceEventType = WorkspaceEvent["type"];

/** Events that describe one board. `board.selected` is workspace-scoped. */
export type BoardScopedEvent = Extract<WorkspaceEvent, { boardId: string }>;

export const BOARD_SCOPED_EVENT_TYPES = [
  "board.created",
  "board.moved",
  "board.removed",
  "board.review_mode_set",
  "board.model_set",
  "board.columns_replaced",
  "board.session_patched",
  "board.task_plan_updated",
  "card.created",
  "card.queued",
  "card.started",
  "card.moved",
  "card.waiting_for_approval",
  "card.completed",
  "card.failed",
  "run.started",
  "step.upserted",
  "step.delta_appended",
  "session.attached",
  "session.starting",
  "session.idle",
  "session.error",
  "session.timeout",
] as const satisfies readonly WorkspaceEventType[];

const BOARD_SCOPED_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  BOARD_SCOPED_EVENT_TYPES
);

/**
 * Narrows to `BoardScopedEvent`.
 *
 * Membership is checked against `BOARD_SCOPED_EVENT_TYPES` rather than merely
 * testing for a `boardId` key, because `board.selected` also carries a
 * `boardId` while being workspace-scoped (its id is `string | null`, so it is
 * excluded from `BoardScopedEvent`). A key-presence test would wrongly claim it.
 */
export function isBoardScopedEvent(
  event: WorkspaceEvent
): event is BoardScopedEvent {
  return (
    "boardId" in event &&
    event.boardId !== null &&
    BOARD_SCOPED_EVENT_TYPE_SET.has(event.type)
  );
}
