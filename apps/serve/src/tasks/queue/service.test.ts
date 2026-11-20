import { describe, expect, test } from "bun:test";
import { BoardTaskService } from "../board-task-service";
import {
  makeMockBridge,
  makeWorkspaceStore,
  NO_SUCH_BOARD,
  seedBoard,
} from "../test-support";

describe("BoardTaskService", () => {
  test("two prompts queued at once dispatch only the first and reject the second", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-card-race-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge, workspaceStore);

    const results = await Promise.allSettled([
      service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "first",
        reviewMode: "auto",
      }),
      service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "second",
        reviewMode: "auto",
      }),
    ]);

    const board = workspaceStore.getBoard(boardId);
    expect(board?.columns.queue).toHaveLength(1);
    expect(board?.session.currentTaskId).toBeDefined();
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(bridge.promptSessionAsync).toHaveBeenCalledTimes(1);
  });
  test("a prompt for an unknown board is refused", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-unknown-board-");
    await workspaceStore.load();
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.queuePrompt({
        boardId: "board-that-does-not-exist",
        directory: "/etc",
        text: "read something I should not",
        reviewMode: "auto",
      })
    ).rejects.toThrow(NO_SUCH_BOARD);

    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(bridge.promptSessionAsync).not.toHaveBeenCalled();
  });
  test("a prompt after a timed-out card creates a new one", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-after-timeout-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-1",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "first run",
      reviewMode: "auto",
    });
    const firstTaskId = workspaceStore.getBoard(boardId)?.session.currentTaskId;

    await workspaceStore.applyAgentEvent({
      activity: "error",
      error: "session timed out",
      sessionID: "sess-1",
      timestamp: Date.now(),
      type: "session.timeout",
    });

    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "second run",
      reviewMode: "auto",
    });

    const board = workspaceStore.getBoard(boardId);
    const queued = board?.columns.queue?.[0];
    expect(queued).toBeDefined();
    expect(queued?.id).not.toBe(firstTaskId);
    expect(board?.session.currentTaskId).toBe(queued?.id);
  });
});
