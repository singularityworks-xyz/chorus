import { z } from "zod";
import {
  boardViewModeSchema,
  workspaceBoardSchema,
  workspaceBoardSessionSchema,
} from "./base/boards";
import { modelSelectionSchema } from "./base/models";
import {
  agentStepSchema,
  columnsSchema,
  pendingApprovalRequestSchema,
  reviewModeSchema,
  taskSchema,
  workspaceColumnIdSchema,
} from "./base/tasks";

export const WORKSPACE_COLUMN_IDS = [
  "queue",
  "in_progress",
  "approve",
  "done",
] as const;

export type WorkspaceColumnId = z.infer<typeof workspaceColumnIdSchema>;

export const WORKSPACE_SNAPSHOT_VERSION = 1;

const workspaceEventBaseSchema = z.object({
  ts: z.number().int().nonnegative(),
});

const boardScopedSchema = workspaceEventBaseSchema.extend({
  boardId: z.string().min(1),
});

export const approvalRequestKindSchema = z.enum(["permission", "question"]);

export type ApprovalRequestKind = z.infer<typeof approvalRequestKindSchema>;

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

export const cardReorderedEventSchema = boardScopedSchema.extend({
  beforeTaskId: z.string().min(1).nullable(),
  column: workspaceColumnIdSchema,
  taskId: z.string().min(1),
  type: z.literal("card.reordered"),
});

export const boardSessionPatchedEventSchema = boardScopedSchema.extend({
  session: workspaceBoardSessionSchema.partial(),
  type: z.literal("board.session_patched"),
});

export const boardTaskPlanUpdatedEventSchema = boardScopedSchema.extend({
  errorMessage: z.string().nullable().optional(),
  plan: z.string(),
  questionAnswers: z.array(z.string()).optional(),
  questions: z.array(z.string()).optional(),
  reviewApproved: z.boolean().optional(),
  taskId: z.string().min(1),
  type: z.literal("board.task_plan_updated"),
});

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
  pendingApproval: pendingApprovalRequestSchema.optional(),
  requestId: z.string().min(1).optional(),
  taskId: z.string().min(1),
  type: z.literal("card.waiting_for_approval"),
});

export const cardApprovalResolvedEventSchema = boardScopedSchema.extend({
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  type: z.literal("card.approval_resolved"),
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

export const cardAbortedEventSchema = boardScopedSchema.extend({
  reason: z.string().optional(),
  taskId: z.string().min(1),
  type: z.literal("card.aborted"),
});

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

export const preferenceRecentModelAddedEventSchema =
  workspaceEventBaseSchema.extend({
    model: modelSelectionSchema,
    type: z.literal("preference.recent_model_added"),
  });

export const preferenceDefaultModelSetEventSchema =
  workspaceEventBaseSchema.extend({
    model: modelSelectionSchema.nullable(),
    type: z.literal("preference.default_model_set"),
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
  cardReorderedEventSchema,
  cardWaitingForApprovalEventSchema,
  cardApprovalResolvedEventSchema,
  cardCompletedEventSchema,
  cardFailedEventSchema,
  cardAbortedEventSchema,
  runStartedEventSchema,
  stepUpsertedEventSchema,
  stepDeltaAppendedEventSchema,
  sessionAttachedEventSchema,
  sessionStartingEventSchema,
  sessionIdleEventSchema,
  sessionErrorEventSchema,
  sessionTimeoutEventSchema,
  preferenceRecentModelAddedEventSchema,
  preferenceDefaultModelSetEventSchema,
  preferenceComposerHintDismissedEventSchema,
  preferenceSpeechVoiceSetEventSchema,
  preferenceBoardViewModeSetEventSchema,
]);

export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
export type WorkspaceEventType = WorkspaceEvent["type"];

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
  "card.reordered",
  "card.waiting_for_approval",
  "card.approval_resolved",
  "card.completed",
  "card.failed",
  "card.aborted",
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

export function isBoardScopedEvent(
  event: WorkspaceEvent
): event is BoardScopedEvent {
  return (
    "boardId" in event &&
    event.boardId !== null &&
    BOARD_SCOPED_EVENT_TYPE_SET.has(event.type)
  );
}
