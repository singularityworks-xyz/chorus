import { describe, expect, test } from "bun:test";
import {
  agentEvent,
  createStore,
  createStoreAt,
  createTempDir,
  mutation,
  seedActiveBoard,
} from "./test-support";

describe("WorkspaceStore agent events", () => {
  test("an agent event expands into several sequenced events", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);

    const commit = await store.applyAgentEvent(
      agentEvent({ activity: "thinking", partID: "p1", text: "pondering" })
    );

    expect(commit?.boardId).toBe(boardId);
    expect(commit?.events.length).toBeGreaterThan(1);
    expect(commit?.events.map((entry) => entry.type)).toEqual([
      "step.upserted",
      "card.started",
    ]);
  });

  test("coalesces streamed deltas without losing per-event idempotency", async () => {
    const dir = createTempDir("chorus-agent-delta-batch-");
    const store = createStoreAt(dir);
    await store.load();
    const boardId = await seedActiveBoard(store);
    const startingSeq = store.headSeq();
    const deltas = ["first ", "second ", "third"].map((delta, index) =>
      agentEvent({
        delta,
        messageID: "message-batched",
        partID: "part-batched",
        sourceEventId: `delta-${index}`,
        timestamp: Date.now() + index,
      })
    );

    const commits = await Promise.all(
      deltas.map((event) => store.applyAgentEvent(event))
    );

    expect(commits[0]).not.toBeNull();
    expect(commits.every((commit) => commit === commits[0])).toBe(true);
    expect(commits[0]?.boardId).toBe(boardId);
    expect(commits[0]?.events).toHaveLength(1);
    expect(commits[0]?.events[0]).toMatchObject({
      delta: "first second third",
      stepId: "part-msg-message-batched-part-batched",
      taskId: "task-1",
      type: "step.delta_appended",
    });
    expect(store.headSeq()).toBe(startingSeq + 1);
    expect(
      store.getBoard(boardId)?.columns.in_progress[0]?.run?.steps[0]?.content
    ).toBe("first second third");

    const replayed = createStoreAt(dir);
    await replayed.load();
    const replayedHead = replayed.headSeq();
    for (const event of deltas) {
      expect(await replayed.applyAgentEvent(event)).toBeNull();
    }
    expect(replayed.headSeq()).toBe(replayedHead);
    expect(
      replayed.getBoard(boardId)?.columns.in_progress[0]?.run?.steps[0]?.content
    ).toBe("first second third");
  });

  test("keeps distinct streamed steps separate in the same batch", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    const commits = await Promise.all([
      store.applyAgentEvent(
        agentEvent({
          delta: "thinking output",
          messageID: "message-multiple-steps",
          partID: "thinking-part",
        })
      ),
      store.applyAgentEvent(
        agentEvent({
          delta: "response output",
          messageID: "message-multiple-steps",
          partID: "response-part",
        })
      ),
    ]);

    expect(commits[0]).not.toBeNull();
    expect(commits.every((commit) => commit === commits[0])).toBe(true);
    expect(commits[0]?.boardId).toBe(boardId);
    expect(
      commits[0]?.events.map((event) =>
        event.type === "step.delta_appended"
          ? { delta: event.delta, stepId: event.stepId }
          : event
      )
    ).toEqual([
      {
        delta: "thinking output",
        stepId: "part-msg-message-multiple-steps-thinking-part",
      },
      {
        delta: "response output",
        stepId: "part-msg-message-multiple-steps-response-part",
      },
    ]);
  });

  test("drops late streamed text after the session releases its task", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    await store.applyAgentEvent(agentEvent({ activity: "idle" }));
    const startingSeq = store.headSeq();

    expect(store.getBoard(boardId)?.session.currentTaskId).toBeUndefined();
    expect(
      await store.applyAgentEvent(
        agentEvent({
          delta: "late text",
          messageID: "message-after-idle",
          partID: "part-after-idle",
          sourceEventId: "late-delta-after-idle",
        })
      )
    ).toBeNull();
    expect(store.headSeq()).toBe(startingSeq);
    expect(store.getBoard(boardId)?.columns.in_progress).toHaveLength(0);
    expect(store.getBoard(boardId)?.columns.done[0]?.run?.steps ?? []).toEqual(
      []
    );
  });

  test("flushes buffered text before a later lifecycle event", async () => {
    const store = createStore();
    await store.load();
    await seedActiveBoard(store);
    const startingSeq = store.headSeq();

    const deltaCommit = store.applyAgentEvent(
      agentEvent({
        delta: "output before idle",
        messageID: "message-barrier",
        partID: "part-barrier",
      })
    );
    const idleCommit = store.applyAgentEvent(agentEvent({ activity: "idle" }));
    const [delta, idle] = await Promise.all([deltaCommit, idleCommit]);
    const appended = store
      .eventsSince(startingSeq)
      .map(({ event }) => event.type);

    expect(delta?.events.map((event) => event.type)).toEqual([
      "step.delta_appended",
    ]);
    expect(idle?.events.map((event) => event.type)).toEqual(["session.idle"]);
    expect(appended).toEqual(["step.delta_appended", "session.idle"]);
  });

  test("flushes buffered text before a later client mutation", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    const startingSeq = store.headSeq();

    const deltaCommit = store.applyAgentEvent(
      agentEvent({
        delta: "output before move",
        messageID: "message-mutation-barrier",
        partID: "part-mutation-barrier",
      })
    );
    const mutationCommit = store.applyMutation(
      mutation("board.move", { boardId, position: { x: 20, y: 30 } })
    );
    const [delta, moved] = await Promise.all([deltaCommit, mutationCommit]);
    const appended = store
      .eventsSince(startingSeq)
      .map(({ event }) => event.type);

    expect(delta?.events.map((event) => event.type)).toEqual([
      "step.delta_appended",
    ]);
    expect(moved?.events.map((event) => event.type)).toEqual(["board.moved"]);
    expect(appended).toEqual(["step.delta_appended", "board.moved"]);
  });

  test("flushes pending streamed text before drain and graceful close", async () => {
    const dir = createTempDir("chorus-agent-delta-close-");
    const store = createStoreAt(dir);
    await store.load();
    const boardId = await seedActiveBoard(store);
    const event = agentEvent({
      delta: "persisted on close",
      messageID: "message-close",
      partID: "part-close",
      sourceEventId: "delta-before-close",
    });

    const pendingCommit = store.applyAgentEvent(event);
    await store.drain();
    expect((await pendingCommit)?.events).toHaveLength(1);
    await store.close();

    const restarted = createStoreAt(dir);
    await restarted.load();
    expect(
      restarted.getBoard(boardId)?.columns.in_progress[0]?.run?.steps[0]
        ?.content
    ).toBe("persisted on close");
    expect(await restarted.applyAgentEvent(event)).toBeNull();
  });

  test("completes an accepted mutation that is queued before graceful close", async () => {
    const dir = createTempDir("chorus-agent-delta-close-mutation-");
    const store = createStoreAt(dir);
    await store.load();
    const boardId = await seedActiveBoard(store);
    const deltaCommit = store.applyAgentEvent(
      agentEvent({
        delta: "output before move",
        messageID: "message-close-mutation",
        partID: "part-close-mutation",
      })
    );
    const mutationCommit = store.applyMutation(
      mutation("board.move", { boardId, position: { x: 20, y: 30 } })
    );
    const close = store.close();

    const [delta, moved] = await Promise.all([deltaCommit, mutationCommit]);
    await close;

    expect(delta?.events.map((event) => event.type)).toEqual([
      "step.delta_appended",
    ]);
    expect(moved?.events.map((event) => event.type)).toEqual(["board.moved"]);
    expect(moved?.firstSeq).toBe((delta?.lastSeq ?? 0) + 1);

    const restarted = createStoreAt(dir);
    await restarted.load();
    expect(restarted.getBoard(boardId)?.position).toEqual({ x: 20, y: 30 });
    expect(
      restarted.getBoard(boardId)?.columns.in_progress[0]?.run?.steps[0]
        ?.content
    ).toBe("output before move");
  });

  test("deduplicates recovered agent events across store restarts", async () => {
    const dir = createTempDir("chorus-agent-receipt-");
    const first = createStoreAt(dir);
    await first.load();
    await seedActiveBoard(first);
    const recoveredEvent = agentEvent({
      activity: "writing",
      messageID: "message-1",
      partID: "part-1",
      sourceEventId: "history:message-1:part-1",
      text: "recovered output",
    });

    const originalCommit = await first.applyAgentEvent(recoveredEvent);
    const headAfterFirstDelivery = first.headSeq();
    expect(originalCommit).not.toBeNull();
    expect(await first.applyAgentEvent(recoveredEvent)).toBeNull();
    expect(first.headSeq()).toBe(headAfterFirstDelivery);
    await first.close();

    const restarted = createStoreAt(dir);
    await restarted.load();
    expect(await restarted.applyAgentEvent(recoveredEvent)).toBeNull();
    expect(restarted.headSeq()).toBe(headAfterFirstDelivery);
    await restarted.close();
  });

  test("agent events for an unknown session are ignored", async () => {
    const store = createStore();
    await store.load();

    expect(
      await store.applyAgentEvent(agentEvent({ activity: "idle" }))
    ).toBeNull();
  });

  test("a completed run survives a restart via replay", async () => {
    const dir = createTempDir("chorus-agent-");

    const first = createStoreAt(dir);
    await first.load();
    await seedActiveBoard(first);

    await first.applyAgentEvent(
      agentEvent({ activity: "thinking", partID: "p1", text: "work" })
    );
    const before = first.getSnapshot();
    await first.close();

    const second = createStoreAt(dir);
    await second.load();
    expect(second.getSnapshot()).toEqual(before);
    await second.close();
  });
});
