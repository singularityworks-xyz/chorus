import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBoard } from "@chorus/contracts";
import { WorkspaceStore } from "../workspace/store";
import { SessionWatchdog } from "./session-watchdog";

/**
 * A session that dies must not be silently orphaned (plan P6 verification:
 * "kill opencode mid-prompt → surfaced as an `error` card").
 *
 * The watchdog is what notices. Nothing about it is engine-specific, so this
 * drives it with a stub bridge rather than a real process: what is under test is
 * that the timeout produces the event the projector turns into a visible error
 * card, not that opencode can be killed on demand.
 */

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

    expect(bridge.abortSession).toHaveBeenCalledWith("sess-1");
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

    // What serve wires up: on timeout, commit the event the projector renders as
    // an error on the card. Asserted here because that wiring is the only thing
    // standing between a dead engine and a board that looks merely idle.
    const watchdog = new SessionWatchdog(
      bridge as never,
      {
        onTimeout: (sessionId, _info, message) => {
          // What serve wires up: on timeout, commit the event the projector
          // renders. Wired here rather than reached into so the test exercises
          // the same seam serve does.
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
    // The card leaves `in_progress` rather than sitting there looking live, and
    // the reason is on the session. The Phase 1 contract puts a timed-out card in
    // `done` with `session.errorMessage`; there is no failed column, and
    // `card.failed` has no producer yet.
    expect(board?.columns.in_progress).toHaveLength(0);
    expect(board?.columns.done?.map((card) => card.id)).toEqual([taskId]);
    expect(board?.session.errorMessage).toContain("timed out");

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

    // Keep the session visibly busy past the original deadline.
    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      watchdog.reset("sess-1");
    }

    // A sliding window, not a cancel: a long run that keeps producing activity is
    // alive, and cancelling outright would let an abandoned session run forever.
    expect(bridge.abortSession).not.toHaveBeenCalled();

    // Once activity stops, it does fire.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bridge.abortSession).toHaveBeenCalledWith("sess-1");

    watchdog.dispose();

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });
});
