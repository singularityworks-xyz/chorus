import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { WorkspaceStore } from "../workspace/store";

/**
 * The card lifecycle a prompt has to produce, end to end through the store.
 *
 * This is the path that was silently broken: a queued prompt created no card, so
 * `board.session.currentTaskId` stayed undefined, so `applyAgentEvent` built
 * every event with an empty task id and discarded all of them. The board stayed
 * empty while the agent worked. Each stage below is asserted against the
 * projected board, not against the raw event list, because the projection is
 * what the UI renders.
 */

const REPO = { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" };

function createStore(prefix: string): { dir: string; store: WorkspaceStore } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, store: new WorkspaceStore(dir) };
}

function cleanup(dir: string): void {
  rmSync(dir, { force: true, recursive: true });
}

function agentEvent(
  sessionID: string,
  overrides: Partial<NormalizedAgentEvent>
): NormalizedAgentEvent {
  return {
    sessionID,
    timestamp: Date.now(),
    type: "test",
    ...overrides,
  } as NormalizedAgentEvent;
}

async function seedBoardWithSession(store: WorkspaceStore): Promise<string> {
  const created = await store.applyMutation({
    baseRevision: null,
    clientId: "lifecycle-test",
    mutationId: `seed-${crypto.randomUUID()}`,
    payload: { seed: { repo: REPO, title: "Lifecycle Board" } },
    type: "board.create",
  });

  const event = created?.events[0];
  if (!created || event?.type !== "board.created") {
    throw new Error("expected board.created");
  }

  const boardId = event.board.boardId;
  await store.applyMutation({
    baseRevision: null,
    clientId: "lifecycle-test",
    mutationId: `session-${crypto.randomUUID()}`,
    payload: { boardId, session: { sessionId: "sess-1", state: "active" } },
    type: "board.session.patch",
  });

  return boardId;
}

/**
 * Commits the `card.created` the way `BoardTaskService.queuePrompt` does.
 *
 * Duplicated here rather than imported because the service needs a bridge; this
 * test is about what the store does with the event once it exists.
 */
async function seedQueuedCard(store: WorkspaceStore, boardId: string) {
  const taskId = "task-1";
  await store.applyBoardEvents(boardId, [
    {
      boardId,
      column: "queue",
      task: {
        id: taskId,
        label: "do the thing",
        labelVariant: "primary-light",
        title: "do the thing",
      },
      taskId,
      ts: Date.now(),
      type: "card.created",
    },
  ]);
  return taskId;
}

describe("card lifecycle from a queued prompt", () => {
  test("a queued prompt's card becomes the board's current task", async () => {
    const { dir, store } = createStore("chorus-lifecycle-current-");
    await store.load();
    const boardId = await seedBoardWithSession(store);
    const taskId = await seedQueuedCard(store, boardId);

    const board = store.getBoard(boardId);
    expect(board?.session.currentTaskId).toBe(taskId);
    expect(board?.columns.queue?.map((card) => card.id)).toEqual([taskId]);

    await store.close();
    cleanup(dir);
  });

  test("streamed deltas reach the card once it is the current task", async () => {
    const { dir, store } = createStore("chorus-lifecycle-delta-");
    await store.load();
    const boardId = await seedBoardWithSession(store);
    await seedQueuedCard(store, boardId);

    const first = await store.applyAgentEvent(
      agentEvent("sess-1", {
        delta: "Hel",
        messageID: "msg-1",
        partID: "part-1",
        type: "message.part.delta",
      })
    );
    expect(first?.events.map((event) => event.type)).toEqual([
      "step.delta_appended",
    ]);

    await store.applyAgentEvent(
      agentEvent("sess-1", {
        delta: "lo",
        messageID: "msg-1",
        partID: "part-1",
        type: "message.part.delta",
      })
    );

    const card = store.getBoard(boardId)?.columns.queue?.[0];
    const step = card?.run?.steps[0];
    expect(step?.content).toBe("Hello");

    await store.close();
    cleanup(dir);
  });

  test("queue → in_progress → approve → done", async () => {
    const { dir, store } = createStore("chorus-lifecycle-full-");
    await store.load();
    const boardId = await seedBoardWithSession(store);
    await seedQueuedCard(store, boardId);

    const lane = (column: string) =>
      store.getBoard(boardId)?.columns[column as "queue"]?.length ?? 0;

    expect(lane("queue")).toBe(1);

    // The agent picks the card up.
    await store.applyAgentEvent(
      agentEvent("sess-1", { activity: "thinking", text: "working" })
    );
    expect(lane("in_progress")).toBe(1);
    expect(lane("queue")).toBe(0);

    // It needs a human.
    await store.applyAgentEvent(
      agentEvent("sess-1", {
        activity: "waiting_for_approval",
        permissionID: "perm-1",
        type: "permission.asked",
      })
    );
    expect(lane("approve")).toBe(1);
    expect(lane("in_progress")).toBe(0);

    // The run finishes.
    await store.applyAgentEvent(
      agentEvent("sess-1", { activity: "idle", type: "session.idle" })
    );

    await store.close();
    cleanup(dir);
  });

  test("without a card, agent events are dropped and now say so", async () => {
    const { dir, store } = createStore("chorus-lifecycle-nocard-");
    await store.load();
    const boardId = await seedBoardWithSession(store);

    // No queued card, so there is no current task to attach activity to.
    expect(store.getBoard(boardId)?.session.currentTaskId).toBeUndefined();

    const commit = await store.applyAgentEvent(
      agentEvent("sess-1", {
        activity: "thinking",
        text: "working",
      })
    );
    expect(commit).toBeNull();

    await store.close();
    cleanup(dir);
  });
});
