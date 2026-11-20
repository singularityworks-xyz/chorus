import { describe, expect, test } from "bun:test";
import { BoardTaskService } from "../board-task-service";
import {
  BoardTaskCommandError,
  GlobalModelNotConfiguredError,
} from "../errors";
import {
  makeMockBridge,
  makeWorkspaceStore,
  REPO,
  reopenWorkspaceStore,
  seedBoard,
} from "../test-support";

describe("BoardTaskService", () => {
  test("creates a session for the first prompt", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-task-create-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge, workspaceStore);

    const result = await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "build feature",
      reviewMode: "auto",
    });

    expect(result.boardId).toBe(boardId);
    expect(result.sessionId).toBe("sess-123");
    expect(result.createdSession).toBe(true);
    expect(bridge.createSession).toHaveBeenCalledWith({
      title: "build feature",
      directory: "/tmp/repo",
    });
    expect(bridge.promptSessionAsync).toHaveBeenCalledWith({
      sessionID: "sess-123",
      directory: "/tmp/repo",
      text: "build feature",
      model: { providerID: "anthropic", modelID: "claude" },
      agent: undefined,
    });
    expect(
      workspaceStore.getBoard(boardId)?.columns.queue[0]?.promptInput
    ).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude" },
      reviewMode: "auto",
      text: "build feature",
    });

    const recoveredStore = await reopenWorkspaceStore(workspaceStore);
    await recoveredStore.load();
    expect(
      recoveredStore.getBoard(boardId)?.columns.queue[0]?.promptInput
    ).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude" },
      reviewMode: "auto",
      text: "build feature",
    });
  });
  test("uses one application model across boards despite client model overrides", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-global-model-");
    await workspaceStore.load();
    let createdSessionCount = 0;
    bridge.createSession.mockImplementation(() => {
      createdSessionCount += 1;
      return Promise.resolve({
        id: `global-model-session-${String(createdSessionCount)}`,
      });
    });
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });
    const secondBoardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      model: { providerID: "openai", modelID: "gpt-5" },
      reviewMode: "auto",
      text: "use the global provider",
    });
    await service.queuePrompt({
      boardId: secondBoardId,
      directory: "/tmp/repo",
      reviewMode: "auto",
      text: "use the same global provider on another board",
    });

    expect(bridge.promptSessionAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: { providerID: "anthropic", modelID: "claude" },
      })
    );
    expect(bridge.promptSessionAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: { providerID: "anthropic", modelID: "claude" },
      })
    );
  });
  test("requires a global model before creating a session", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-no-global-model-");
    await workspaceStore.load();
    const boardId = await seedBoard(
      workspaceStore,
      { state: "uninitialized" },
      REPO,
      false
    );
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        reviewMode: "auto",
        text: "do not silently use the project provider",
      })
    ).rejects.toBeInstanceOf(GlobalModelNotConfiguredError);
    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(bridge.promptSessionAsync).not.toHaveBeenCalled();
  });
  test("reuses the persisted session for later prompts", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-task-reuse-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });

    const service = new BoardTaskService(bridge, workspaceStore);

    const result = await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "follow up",
      reviewMode: "auto",
    });

    expect(result.createdSession).toBe(false);
    expect(bridge.createSession).toHaveBeenCalledTimes(0);
    expect(bridge.promptSessionAsync).toHaveBeenLastCalledWith({
      sessionID: "sess-123",
      directory: "/tmp/repo",
      text: "follow up",
      model: { providerID: "anthropic", modelID: "claude" },
      agent: undefined,
    });
  });
  test("binds the created session onto the board in the event log", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-task-bind-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge, workspaceStore);
    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "build feature",
      reviewMode: "auto",
    });

    expect(workspaceStore.getBoard(boardId)?.session.sessionId).toBe(
      "sess-123"
    );
    const reopened = await reopenWorkspaceStore(workspaceStore);
    await reopened.load();
    expect(reopened.getBoard(boardId)?.session.sessionId).toBe("sess-123");
  });
  test("queueing a prompt creates the card that agent events attach to", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-task-card-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge, workspaceStore);
    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "build the feature",
      reviewMode: "auto",
    });

    const board = workspaceStore.getBoard(boardId);
    const card = board?.columns.queue?.[0];

    expect(card).toBeDefined();
    expect(card?.title).toBe("build the feature");

    expect(board?.session.currentTaskId).toBe(card?.id);
  });
  test("a second prompt on a live board is rejected rather than attached to that run", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-task-card2-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge, workspaceStore);
    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "first prompt",
      reviewMode: "auto",
    });
    const firstTaskId = workspaceStore.getBoard(boardId)?.session.currentTaskId;

    await expect(
      service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "second prompt",
        reviewMode: "auto",
      })
    ).rejects.toBeInstanceOf(BoardTaskCommandError);

    const board = workspaceStore.getBoard(boardId);
    expect(board?.columns.queue).toHaveLength(1);
    expect(board?.session.currentTaskId).toBe(firstTaskId);
    expect(bridge.promptSessionAsync).toHaveBeenCalledTimes(1);
  });
  test("a card is created even when the session was reused", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-task-card3-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "uninitialized",
    });

    const service = new BoardTaskService(bridge, workspaceStore);
    const result = await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "continue the work",
      reviewMode: "auto",
    });

    expect(result.createdSession).toBe(false);
    expect(workspaceStore.getBoard(boardId)?.columns.queue).toHaveLength(1);
    expect(
      workspaceStore.getBoard(boardId)?.session.currentTaskId
    ).toBeDefined();
  });
});
