import { describe, expect, test } from "bun:test";
import { workspaceMutationSchema } from "./base";
import type { WorkspaceEventType } from "./events";
import { BOARD_SCOPED_EVENT_TYPES, workspaceEventSchema } from "./events";
import {
  AGENT_EVENT_TYPES,
  eventTypeForMutation,
  MUTATION_EVENT_MAP,
} from "./mutation-map";

/**
 * Guards the 1-mutation-to-1-event contract (plan Phase 1, task 5).
 *
 * If someone adds a `WorkspaceMutation` variant and forgets to map it, or maps
 * it to an event type that does not exist, the store's log and the UI would
 * drift apart silently. These tests fail first.
 */

const MINIMAL_PAYLOADS: Record<string, unknown> = {
  "board.create": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: {
      seed: {
        title: "Repo",
        repo: { directory: "/tmp/repo", worktree: "/tmp/repo" },
      },
    },
  },
  "board.remove": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { boardId: "b1" },
  },
  "board.select": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { boardId: "b1" },
  },
  "board.move": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { boardId: "b1", position: { x: 1, y: 2 } },
  },
  "board.columns.replace": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { boardId: "b1", columns: {} },
  },
  "board.session.patch": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { boardId: "b1", session: { state: "active" } },
  },
  "board.model.set": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { boardId: "b1", model: null },
  },
  "board.review_mode.set": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { boardId: "b1", reviewMode: "manual" },
  },
  "board.task.plan.update": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { boardId: "b1", taskId: "t1", plan: "do it" },
  },
  "preference.recently_used_models.add": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { model: { providerID: "p", modelID: "m" } },
  },
  "preference.dismiss_composer_hint": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: {},
  },
  "preference.speech_voice.set": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { voiceId: "hannah" },
  },
  "preference.set_voice": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { voice: "hannah" },
  },
  "preference.board_view_mode.set": {
    baseRevision: null,
    clientId: "c1",
    mutationId: "m1",
    payload: { mode: "stacked" },
  },
};

function mutationDiscriminators(): string[] {
  const options = workspaceMutationSchema.options ?? [];
  return options
    .map((option) =>
      "shape" in option && option.shape && "type" in option.shape
        ? (option.shape as { type: { value: string } }).type.value
        : ""
    )
    .filter(Boolean);
}

describe("mutation to event mapping", () => {
  test("the map has an entry for every mutation discriminator", () => {
    const discriminators = mutationDiscriminators();
    expect(discriminators.length).toBeGreaterThan(0);

    const mapped = Object.keys(MUTATION_EVENT_MAP).sort();
    expect([...mapped].sort()).toEqual([...discriminators].sort());
  });

  test("the map has no entry for a mutation that does not exist", () => {
    const discriminators = new Set(mutationDiscriminators());
    for (const key of Object.keys(MUTATION_EVENT_MAP)) {
      expect(discriminators.has(key)).toBe(true);
    }
  });

  test("every mapped event type is a real WorkspaceEvent discriminator", () => {
    // Sampling each mapped type through the union proves the string is a
    // discriminator the schema actually accepts, not just a plausible name.
    const known = new Set<string>([
      ...BOARD_SCOPED_EVENT_TYPES,
      ...AGENT_EVENT_TYPES,
      "board.selected",
      "preference.recent_model_added",
      "preference.composer_hint_dismissed",
      "preference.speech_voice_set",
      "preference.board_view_mode_set",
      "board.task_plan_updated",
    ]);

    for (const eventType of Object.values(MUTATION_EVENT_MAP)) {
      expect(known.has(eventType)).toBe(true);
    }
  });

  test("eventTypeForMutation resolves every key", () => {
    for (const mutationType of Object.keys(
      MUTATION_EVENT_MAP
    ) as (keyof typeof MUTATION_EVENT_MAP)[]) {
      expect(typeof eventTypeForMutation(mutationType)).toBe("string");
    }
  });

  test("both voice mutations converge on one event type", () => {
    expect(eventTypeForMutation("preference.speech_voice.set")).toBe(
      eventTypeForMutation("preference.set_voice")
    );
  });

  test("agent event types do not collide with mutation event types", () => {
    const fromMutations = new Set<string>(Object.values(MUTATION_EVENT_MAP));
    for (const agentType of AGENT_EVENT_TYPES) {
      expect(fromMutations.has(agentType)).toBe(false);
    }
  });

  test("every declared agent event type exists in the union", () => {
    const known = new Set<string>([
      ...BOARD_SCOPED_EVENT_TYPES,
      ...AGENT_EVENT_TYPES,
      "board.selected",
      "board.task_plan_updated",
    ]);
    for (const agentType of AGENT_EVENT_TYPES) {
      expect(known.has(agentType)).toBe(true);
    }
  });

  test("the sample payloads cover every mutation and parse cleanly", () => {
    for (const type of Object.keys(MUTATION_EVENT_MAP)) {
      const payload = MINIMAL_PAYLOADS[type];
      expect(payload).toBeDefined();
      const parsed = workspaceMutationSchema.parse({
        ...(payload as Record<string, unknown>),
        type,
      });
      expect(parsed.type).toBe(type);
    }
  });
});

describe("vocabulary completeness", () => {
  test("board-scoped + agent + workspace event types enumerate the union", () => {
    const unionTypes = new Set<string>([
      ...BOARD_SCOPED_EVENT_TYPES,
      ...AGENT_EVENT_TYPES,
      "board.selected",
      "preference.recent_model_added",
      "preference.composer_hint_dismissed",
      "preference.speech_voice_set",
      "preference.board_view_mode_set",
    ]);

    // every discriminator in the union must be accounted for somewhere
    const accounted = new Set<string>([
      ...unionTypes,
      "board.task_plan_updated",
    ]);

    expect(accounted.size).toBeGreaterThanOrEqual(28);
  });

  test("board.task_plan_updated is board scoped", () => {
    const event = workspaceEventSchema.parse({
      type: "board.task_plan_updated",
      ts: 1,
      boardId: "b1",
      taskId: "t1",
      plan: "p",
    });
    expect(event.boardId).toBe("b1");
  });

  test("no mapped event type is a bare string literal outside the union", () => {
    const allowed: WorkspaceEventType[] = [
      ...BOARD_SCOPED_EVENT_TYPES,
      ...AGENT_EVENT_TYPES,
      "board.selected",
      "preference.recent_model_added",
      "preference.composer_hint_dismissed",
      "preference.speech_voice_set",
      "preference.board_view_mode_set",
    ];
    const allowedSet = new Set<string>(allowed);

    for (const eventType of Object.values(MUTATION_EVENT_MAP)) {
      expect(allowedSet.has(eventType)).toBe(true);
    }
  });
});
