import { describe, expect, test } from "bun:test";
import {
  agentEvent,
  createStore,
  createStoreAt,
  createTempDir,
  mutation,
  seedActiveBoard,
  seedBoard,
} from "./test-support";

describe("WorkspaceStore idempotency", () => {
  test("a repeated mutationId is a no-op", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const repeat = mutation("board.move", {
      boardId,
      position: { x: 7, y: 8 },
    });

    const first = await store.applyMutation(repeat);
    expect(first).not.toBeNull();

    const headAfterFirst = store.headSeq();
    const second = await store.applyMutation(repeat);
    expect(second).toBeNull();
    expect(store.headSeq()).toBe(headAfterFirst);
  });

  test("idempotency survives a restart", async () => {
    const dir = createTempDir("chorus-dedup-");

    const first = createStoreAt(dir);
    await first.load();
    const boardId = await seedBoard(first);

    await first.applyMutation({
      baseRevision: null,
      clientId: "test-client",
      mutationId: "repeatable-id",
      payload: { boardId, position: { x: 7, y: 8 } },
      type: "board.move",
    });
    await first.close();

    const second = createStoreAt(dir);
    await second.load();

    const head = second.headSeq();
    const replay = await second.applyMutation({
      baseRevision: null,
      clientId: "test-client",
      mutationId: "repeatable-id",
      payload: { boardId, position: { x: 7, y: 8 } },
      type: "board.move",
    });

    expect(replay).toBeNull();
    expect(second.headSeq()).toBe(head);
    await second.close();
  });

  test("a mutation addressing a missing board is a no-op", async () => {
    const store = createStore();
    await store.load();

    const commit = await store.applyMutation(
      mutation("board.move", { boardId: "ghost", position: { x: 1, y: 1 } })
    );

    expect(commit).toBeNull();
    expect(store.headSeq()).toBe(0);
  });
});

describe("WorkspaceStore serialization", () => {
  test("a parallel mutation storm is serialized and complete", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const storm = await Promise.all(
      Array.from({ length: 200 }, (_unused, index) =>
        store.applyMutation(
          mutation("board.move", {
            boardId,
            position: { x: index, y: index },
          })
        )
      )
    );

    const committed = storm.filter((entry) => entry !== null);
    expect(committed).toHaveLength(200);

    const seqs = committed.map((entry) => entry.lastSeq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(2);
    expect(seqs.length).toBe(200);
    expect(seqs.at(-1)).toBe(201);
    expect(store.headSeq()).toBe(201);
    expect(store.getSnapshot().revision).toBe(201);
  });

  test("concurrent agent events and mutations do not interleave", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);

    const results = await Promise.all([
      ...Array.from({ length: 25 }, (_unused, index) =>
        store.applyMutation(
          mutation("board.move", { boardId, position: { x: index, y: 0 } })
        )
      ),
      ...Array.from({ length: 25 }, (_unused, index) =>
        store.applyAgentEvent(
          agentEvent({ activity: "thinking", partID: `p${index}`, text: "x" })
        )
      ),
    ]);

    const commits = results.filter((entry) => entry !== null);
    const seqs = commits.map((entry) => entry.lastSeq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(store.headSeq()).toBe(seqs.at(-1) ?? -1);
  });

  test("drain resolves only after queued work commits", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const queued = Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        store.applyMutation(
          mutation("board.move", { boardId, position: { x: index, y: index } })
        )
      )
    );

    await store.drain();
    await queued;

    expect(store.headSeq()).toBe(51);
  });
});
