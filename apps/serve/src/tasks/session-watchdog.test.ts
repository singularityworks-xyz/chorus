import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBoard } from "@chorus/contracts";
import { WorkspaceStore } from "../workspace/store";
import { SessionWatchdog } from "./session-watchdog";

const REPO = { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" };

const noopCallbacks = { onTimeout: () => undefined };

function makeBridge() {
  return {
    abortSession: mock(async () => undefined),
  };
}

async function seedBoardWithCard(
  store: WorkspaceStore
): Promise<{ boardId: string; taskId: string }> {
  const created = await store.applyMutation({
    baseRevision: null,
    clientId: "watchdog-test",
    mutationId: `board-${crypto.randomUUID()}`,
    payload: { seed: { repo: REPO, title: "Watchdog Board" } },
    type: "board.create",
  });

  const event = created?.events[0];
  if (!created || event?.type !== "board.created") {
    throw new Error("expected board.created");
  }

  const boardId = event.board.boardId;
  await store.applyMutation({
    baseRevision: null,
    clientId: "watchdog-test",
    mutationId: `session-${crypto.randomUUID()}`,
    payload: { boardId, session: { sessionId: "sess-1", state: "active" } },
    type: "board.session.patch",
  });

  const taskId = "task-1";
  await store.applyBoardEvents(boardId, [
    {
      boardId,
      column: "in_progress",
      task: {
        id: taskId,
        label: "long job",
        labelVariant: "primary-light",
        title: "long job",
      },
      taskId,
      ts: Date.now(),
      type: "card.created",
    },
  ]);

  return { boardId, taskId };
}

describe("SessionWatchdog", () => {
  test("a timed-out session is aborted on the bridge", async () => {
    const bridge = makeBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-watchdog-"));
    const store = new WorkspaceStore(dir);
    await store.load();
    const { boardId } = await seedBoardWithCard(store);

    const watchdog = new SessionWatchdog(bridge as never, noopCallbacks, 10);
    watchdog.start("sess-1", { boardId, directory: REPO.directory });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(bridge.abortSession).toHaveBeenCalledWith("sess-1", REPO.directory);
    watchdog.dispose();

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("a timeout surfaces as a session timeout event, not silence", async () => {
    const bridge = makeBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-watchdog-event-"));
    const store = new WorkspaceStore(dir);
    await store.load();
    const { boardId, taskId } = await seedBoardWithCard(store);

    const watchdog = new SessionWatchdog(
      bridge as never,
      {
        onTimeout: (sessionId, _info, message) => {
          store
            .applyAgentEvent({
              activity: "error",
              error: message,
              sessionID: sessionId,
              timestamp: Date.now(),
              type: "session.timeout",
            })
            .catch(() => undefined);
        },
      },
      10
    );

    watchdog.start("sess-1", { boardId, directory: REPO.directory });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const board: WorkspaceBoard | undefined = store.getBoard(boardId);
    const eventTypes = store
      .eventsSince(0, 500)
      .map((record) => record.event.type);

    expect(eventTypes).toContain("session.timeout");

    expect(board?.columns.in_progress).toHaveLength(0);
    expect(board?.columns.done?.map((card) => card.id)).toEqual([taskId]);
    expect(board?.session.errorMessage).toContain("timed out");

    watchdog.dispose();

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("the first recovered activity re-arms a missing watchdog", async () => {
    const bridge = makeBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-watchdog-recovered-"));
    const store = new WorkspaceStore(dir);
    await store.load();
    const { boardId } = await seedBoardWithCard(store);

    const watchdog = new SessionWatchdog(bridge as never, noopCallbacks, 10);
    watchdog.observeActivity("sess-1", {
      boardId,
      directory: REPO.directory,
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(bridge.abortSession).toHaveBeenCalledWith("sess-1", REPO.directory);
    expect(watchdog.getStatus().activeSessions).toBe(0);
    watchdog.dispose();

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("an idle session can be removed before its timeout", async () => {
    const bridge = makeBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-watchdog-idle-"));
    const store = new WorkspaceStore(dir);
    await store.load();
    const { boardId } = await seedBoardWithCard(store);

    const watchdog = new SessionWatchdog(bridge as never, noopCallbacks, 30);
    watchdog.start("sess-1", { boardId, directory: REPO.directory });
    watchdog.stop("sess-1");

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(bridge.abortSession).not.toHaveBeenCalled();
    expect(watchdog.getStatus().activeSessions).toBe(0);
    watchdog.dispose();

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("activity slides the deadline instead of cancelling it", async () => {
    const bridge = makeBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-watchdog-reset-"));
    const store = new WorkspaceStore(dir);
    await store.load();
    const { boardId } = await seedBoardWithCard(store);

    const watchdog = new SessionWatchdog(bridge as never, noopCallbacks, 120);
    watchdog.start("sess-1", { boardId, directory: REPO.directory });

    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      watchdog.reset("sess-1");
    }

    expect(bridge.abortSession).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bridge.abortSession).toHaveBeenCalledWith("sess-1", REPO.directory);

    watchdog.dispose();

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });
});
