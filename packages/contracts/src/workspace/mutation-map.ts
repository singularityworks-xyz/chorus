import type { WorkspaceEventType } from "./events";

export const MUTATION_EVENT_MAP = {
  "board.create": "board.created",
  "board.remove": "board.removed",
  "board.select": "board.selected",
  "board.move": "board.moved",
  "board.task.reorder": "card.reordered",
  "board.columns.replace": "board.columns_replaced",
  "board.session.patch": "board.session_patched",
  "board.model.set": "board.model_set",
  "board.review_mode.set": "board.review_mode_set",
  "board.task.plan.update": "board.task_plan_updated",
  "preference.recently_used_models.add": "preference.recent_model_added",
  "preference.default_model.set": "preference.default_model_set",
  "preference.dismiss_composer_hint": "preference.composer_hint_dismissed",
  "preference.speech_voice.set": "preference.speech_voice_set",
  "preference.set_voice": "preference.speech_voice_set",
  "preference.board_view_mode.set": "preference.board_view_mode_set",
} as const satisfies Record<string, WorkspaceEventType>;

export type MutationType = keyof typeof MUTATION_EVENT_MAP;

export function eventTypeForMutation(
  mutationType: MutationType
): WorkspaceEventType {
  return MUTATION_EVENT_MAP[mutationType];
}

export const AGENT_EVENT_TYPES = [
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
