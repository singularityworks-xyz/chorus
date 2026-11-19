import { describe, expect, test } from "bun:test";
import { BoardTaskService } from "../board-task-service";
import {
  addSavedTask,
  makeMockBridge,
  makeWorkspaceStore,
  seedBoard,
} from "../test-support";

describe("BoardTaskService", () => {
  test("session history enables undo for an idle board session", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    const workspaceStore = makeWorkspaceStore("chorus-session-history-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    const state = await service.getSessionHistoryState(boardId);

    expect(state).toMatchObject({
      boardId,
      canRedo: false,
      canUndo: true,
      busy: false,
      sessionId: "sess-123",
    });
    expect(bridge.getSession).toHaveBeenCalledWith({
      engineDirectory: "/tmp/repo",
      sessionID: "sess-123",
    });
    expect(bridge.sessionMessages).toHaveBeenCalledWith(
      "sess-123",
      "/tmp/repo"
    );
  });
  test("an empty session has no undo action", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.sessionMessages.mockResolvedValue([]);
    const workspaceStore = makeWorkspaceStore("chorus-session-empty-history-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.getSessionHistoryState(boardId)
    ).resolves.toMatchObject({ canRedo: false, canUndo: false, busy: false });
    await expect(
      service.sessionHistoryCommand(boardId, "undo")
    ).rejects.toMatchObject({ code: "session_nothing_to_undo" });
    expect(bridge.revertSession).not.toHaveBeenCalled();
  });
  test("a stale pointer to a completed task does not lock session history", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    const workspaceStore = makeWorkspaceStore(
      "chorus-session-history-stale-task-"
    );
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    await addSavedTask(workspaceStore, boardId, "task-completed");
    await workspaceStore.applyBoardEvents(boardId, [
      {
        boardId,
        taskId: "task-completed",
        ts: Date.now(),
        type: "card.completed",
      },
    ]);
    await workspaceStore.applyMutation({
      baseRevision: null,
      clientId: "task-test",
      mutationId: `stale-session-task-${crypto.randomUUID()}`,
      payload: {
        boardId,
        session: { currentTaskId: "task-completed" },
      },
      type: "board.session.patch",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.getSessionHistoryState(boardId)
    ).resolves.toMatchObject({ busy: false, canUndo: true, canRedo: false });
  });
  test("undo and redo use the board session without changing task history", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    let reverted = false;
    bridge.getSession.mockImplementation(async () => ({
      directory: "/tmp/repo",
      id: "sess-123",
      revert: reverted ? { messageID: "message-1" } : undefined,
    }));
    bridge.revertSession.mockImplementation(() => {
      reverted = true;
      return Promise.resolve({ messageID: "message-1" });
    });
    bridge.unrevertSession.mockImplementation(() => {
      reverted = false;
      return Promise.resolve(undefined);
    });
    const workspaceStore = makeWorkspaceStore("chorus-session-command-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);
    const before = workspaceStore.getBoard(boardId)?.columns;

    const undone = await service.sessionHistoryCommand(boardId, "undo");

    expect(undone).toMatchObject({
      accepted: true,
      boardId,
      command: "undo",
      sessionId: "sess-123",
    });
    expect(bridge.revertSession).toHaveBeenCalledWith("sess-123", "/tmp/repo");
    expect(workspaceStore.getBoard(boardId)?.columns).toEqual(before);
    await expect(
      service.getSessionHistoryState(boardId)
    ).resolves.toMatchObject({
      canRedo: true,
      canUndo: false,
    });

    const redone = await service.sessionHistoryCommand(boardId, "redo");

    expect(redone.command).toBe("redo");
    expect(bridge.unrevertSession).toHaveBeenCalledWith(
      "sess-123",
      "/tmp/repo"
    );
    expect(workspaceStore.getBoard(boardId)?.columns).toEqual(before);
    await expect(
      service.getSessionHistoryState(boardId)
    ).resolves.toMatchObject({
      canRedo: false,
      canUndo: true,
    });
  });
  test("session history reports redo when OpenCode has an active revert", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.getSession.mockResolvedValue({
      directory: "/tmp/repo",
      id: "sess-123",
      revert: { messageID: "message-1" },
    });
    const workspaceStore = makeWorkspaceStore("chorus-session-redo-state-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    const state = await service.getSessionHistoryState(boardId);

    expect(state).toMatchObject({ canRedo: true, canUndo: false, busy: false });
  });
  test("session history refuses busy work without reverting the session", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(false);
    const workspaceStore = makeWorkspaceStore("chorus-session-busy-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.getSessionHistoryState(boardId)
    ).resolves.toMatchObject({ busy: true, canUndo: false, canRedo: false });
    await expect(
      service.sessionHistoryCommand(boardId, "undo")
    ).rejects.toMatchObject({ code: "session_busy" });
    expect(bridge.revertSession).not.toHaveBeenCalled();
  });
  test("session history refuses sessions owned by another checkout", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.getSession.mockResolvedValue({
      directory: "/tmp/other-repo",
      id: "sess-123",
      revert: undefined,
    });
    const workspaceStore = makeWorkspaceStore("chorus-session-owner-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.sessionHistoryCommand(boardId, "undo")
    ).rejects.toMatchObject({ code: "session_ownership_conflict" });
    expect(bridge.revertSession).not.toHaveBeenCalled();
  });
  test("session history reads return repository-specific retry guidance", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.getSession.mockRejectedValue(new Error("engine unavailable"));
    const workspaceStore = makeWorkspaceStore(
      "chorus-session-history-read-failure-"
    );
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(service.getSessionHistoryState(boardId)).rejects.toMatchObject(
      {
        code: "session_history_unavailable",
        message:
          "Could not load repository history for this board. Refresh the board and retry.",
      }
    );
  });
  test("session history failures return explicit retryable errors", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.revertSession.mockRejectedValue(new Error("engine unavailable"));
    const workspaceStore = makeWorkspaceStore(
      "chorus-session-history-failure-"
    );
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.sessionHistoryCommand(boardId, "undo")
    ).rejects.toMatchObject({ code: "session_command_failed" });
  });
});
