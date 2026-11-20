import { describe, expect, test } from "bun:test";
import { boardCreatedEventSchema, workspaceEventSchema } from "../events";
import { ALL_TYPES, EVENT_CORPUS, TS } from "./test-support";

describe("WorkspaceEvent round-trip", () => {
  test("the corpus covers every discriminator the union declares", () => {
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length);
    expect(ALL_TYPES.length).toBeGreaterThanOrEqual(28);
  });

  for (const type of ALL_TYPES) {
    test(`${type} survives parse -> serialize -> parse`, () => {
      const original = EVENT_CORPUS[type];
      const parsed = workspaceEventSchema.parse(original);
      expect(parsed).toEqual(original);

      const roundTripped = workspaceEventSchema.parse(
        JSON.parse(JSON.stringify(parsed))
      );
      expect(roundTripped).toEqual(original);
    });
  }

  test("rejects an unknown discriminator", () => {
    expect(() =>
      workspaceEventSchema.parse({ type: "board.teleported", ts: TS })
    ).toThrow();
  });

  test("rejects an event with no discriminator", () => {
    expect(() => workspaceEventSchema.parse({ ts: TS })).toThrow();
  });

  test("rejects an event missing its timestamp", () => {
    const { ts: _ts, ...withoutTs } = EVENT_CORPUS["board.moved"];
    expect(() => workspaceEventSchema.parse(withoutTs)).toThrow();
  });

  test("rejects a negative timestamp", () => {
    expect(() =>
      workspaceEventSchema.parse({
        type: "board.removed",
        ts: -1,
        boardId: "b",
      })
    ).toThrow();
  });

  test("rejects an empty boardId", () => {
    expect(() =>
      workspaceEventSchema.parse({ type: "board.removed", ts: TS, boardId: "" })
    ).toThrow();
  });

  test("rejects an unknown approval request kind", () => {
    expect(() =>
      workspaceEventSchema.parse({
        type: "card.waiting_for_approval",
        ts: TS,
        boardId: "board-1",
        taskId: "task-1",
        kind: "telepathy",
      })
    ).toThrow();
  });

  test("rejects a board.created event whose board fails its own schema", () => {
    expect(() =>
      boardCreatedEventSchema.parse({
        type: "board.created",
        ts: TS,
        boardId: "board-1",
        board: { boardId: "" },
      })
    ).toThrow();
  });
});
