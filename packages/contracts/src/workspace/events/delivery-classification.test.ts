import { describe, expect, test } from "bun:test";
import type { WorkspaceEvent } from "../events";
import { isCoalescibleEvent, isControlEvent } from "../protocol";
import { ALL_TYPES, EVENT_CORPUS } from "./test-support";

describe("control vs coalescible events", () => {
  const EXPECTED_COALESCIBLE: WorkspaceEvent["type"][] = [
    "step.upserted",
    "step.delta_appended",
  ];

  test("exactly the step events are coalescible", () => {
    const coalescible = ALL_TYPES.filter((type) =>
      isCoalescibleEvent(EVENT_CORPUS[type])
    );

    expect(coalescible.sort()).toEqual([...EXPECTED_COALESCIBLE].sort());
  });

  test("every non-coalescible event is classified as control", () => {
    const control = ALL_TYPES.filter((type) =>
      isControlEvent(EVENT_CORPUS[type])
    );

    expect(control.sort()).toEqual(
      ALL_TYPES.filter((t) => !EXPECTED_COALESCIBLE.includes(t)).sort()
    );
  });

  test("run.started is a control event, not batchable", () => {
    expect(isControlEvent(EVENT_CORPUS["run.started"])).toBe(true);
    expect(isCoalescibleEvent(EVENT_CORPUS["run.started"])).toBe(false);
  });

  test("a plan update is a control event, not batchable", () => {
    expect(isControlEvent(EVENT_CORPUS["board.task_plan_updated"])).toBe(true);
  });

  test("an approval request is never coalescible", () => {
    expect(isControlEvent(EVENT_CORPUS["card.waiting_for_approval"])).toBe(
      true
    );
    expect(isCoalescibleEvent(EVENT_CORPUS["card.waiting_for_approval"])).toBe(
      false
    );
  });

  test("workspace-scoped preference events are control", () => {
    for (const type of [
      "preference.composer_hint_dismissed",
      "preference.speech_voice_set",
      "preference.board_view_mode_set",
      "preference.recent_model_added",
    ] as const) {
      expect(isControlEvent(EVENT_CORPUS[type])).toBe(true);
    }
  });
});
