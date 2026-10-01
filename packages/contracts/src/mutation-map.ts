import type { WorkspaceEventType } from "./events";

/**
 * Mutation → Event mapping (plan Phase 1, task 5).
 *
 * The 1-mutation-to-1-event contract: every `WorkspaceMutation` variant is
 * translated by the store into **exactly one** `WorkspaceEvent`, which is what
 * gets appended to the SQLite log in Phase 2. A mutation that produced two
 * events would break replay determinism; a mutation producing zero would be
 * silently lost on restart.
 *
 * `apps/serve/src/workspace/store.ts` owns this translation. This table is the
 * specification it must satisfy, and `mutation-event-map.test.ts` asserts the
 * two agree — so adding a mutation without an event fails CI.
 *
 * | mutation                                | event                                |
 * | --------------------------------------- | ------------------------------------ |
 * | board.create                            | board.created                        |
 * | board.remove                            | board.removed                        |
 * | board.select                            | board.selected                       |
 * | board.move                              | board.moved                          |
 * | board.columns.replace                   | board.columns_replaced               |
 * | board.session.patch                     | board.session_patched                |
 * | board.model.set                         | board.model_set                      |
 * | board.review_mode.set                   | board.review_mode_set                |
 * | board.task.plan.update                  | board.task_plan_updated              |
 * | preference.recently_used_models.add     | preference.recent_model_added        |
 * | preference.dismiss_composer_hint        | preference.composer_hint_dismissed   |
 * | preference.speech_voice.set             | preference.speech_voice_set          |
 * | preference.set_voice                    | preference.speech_voice_set          |
 * | preference.board_view_mode.set          | preference.board_view_mode_set       |
 *
 * Agent-driven events (`card.*`, `run.*`, `step.*`, `session.*`) originate from
 * the opencode adapter rather than from an HTTP mutation; they are listed in
 * `AGENT_EVENT_TYPES` so the vocabulary stays auditable in one place.
 */
export const MUTATION_EVENT_MAP = {
  "board.create": "board.created",
  "board.remove": "board.removed",
  "board.select": "board.selected",
  "board.move": "board.moved",
  "board.columns.replace": "board.columns_replaced",
  "board.session.patch": "board.session_patched",
  "board.model.set": "board.model_set",
  "board.review_mode.set": "board.review_mode_set",
  "board.task.plan.update": "board.task_plan_updated",
  "preference.recently_used_models.add": "preference.recent_model_added",
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

/**
 * Events produced by the opencode adapter (not by a client mutation). Kept
 * explicit so the persisted vocabulary is fully enumerable from this package.
 */
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
