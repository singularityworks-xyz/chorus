import { describe, expect, test } from "bun:test";
import { BoardTaskService } from "../board-task-service";
import {
  addSavedTask,
  makeMockBridge,
  makeWorkspaceStore,
  seedBoard,
} from "../test-support";

describe("BoardTaskService", () => {
  test("runs the saved prompt for an explicitly targeted queued card once", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-task-run-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });
    await addSavedTask(
      workspaceStore,
      boardId,
      "task-run-1",
      "saved run prompt"
    );
    const service = new BoardTaskService(bridge, workspaceStore);

    const first = await service.runQueuedTask(boardId, "task-run-1");
    const duplicate = await service.runQueuedTask(boardId, "task-run-1");

    expect(first).toMatchObject({ status: "accepted", taskId: "task-run-1" });
    expect(duplicate).toMatchObject({
      status: "already_running",
      taskId: "task-run-1",
    });
    expect(bridge.promptSessionAsync).toHaveBeenCalledTimes(1);
    expect(bridge.promptSessionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ text: "saved run prompt" })
    );
  });
  test("retry creates a child card with the persisted prompt", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-task-retry-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });
    await addSavedTask(
      workspaceStore,
      boardId,
      "task-finished-1",
      "retry prompt"
    );
    await workspaceStore.applyBoardEvents(boardId, [
      {
        boardId,
        taskId: "task-finished-1",
        ts: Date.now(),
        type: "card.completed",
      },
    ]);
    const service = new BoardTaskService(bridge, workspaceStore);

    const result = await service.retryTask(boardId, "task-finished-1");
    const retry = workspaceStore.getBoard(boardId)?.columns.queue[0];
    if (!retry) {
      throw new Error("retry task was not created");
    }

    expect(result.status).toBe("accepted");
    expect(result.taskId).toBe(retry.id);
    expect(result.retryOf).toBe("task-finished-1");
    expect(retry).toMatchObject({ retryOf: "task-finished-1" });
    expect(retry?.promptInput?.text).toBe("retry prompt");
    expect(bridge.promptSessionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ text: "retry prompt" })
    );
  });
  test("keeps active work on its selected model and retries with the current global model", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore(
      "chorus-board-model-change-retry-"
    );
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });
    const service = new BoardTaskService(bridge, workspaceStore);

    const firstRun = await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      model: { modelID: "gpt-5", providerID: "openai" },
      reviewMode: "auto",
      text: "keep the active run stable",
    });
    const startedAt = Date.now();
    await workspaceStore.applyBoardEvents(boardId, [
      {
        boardId,
        taskId: firstRun.taskId,
        ts: startedAt,
        type: "card.started",
      },
      {
        boardId,
        model: "anthropic/claude",
        sessionId: firstRun.sessionId,
        startedAt,
        taskId: firstRun.taskId,
        taskTitle: "keep the active run stable",
        ts: startedAt + 1,
        type: "run.started",
      },
    ]);

    await workspaceStore.applyMutation({
      baseRevision: null,
      clientId: "task-test",
      mutationId: `change-default-model-${crypto.randomUUID()}`,
      payload: { model: { modelID: "gpt-5", providerID: "openai" } },
      type: "preference.default_model.set",
    });

    expect(
      workspaceStore.getBoard(boardId)?.columns.in_progress[0]?.run?.model
    ).toBe("anthropic/claude");

    await workspaceStore.applyBoardEvents(boardId, [
      {
        boardId,
        taskId: firstRun.taskId,
        ts: startedAt + 2,
        type: "card.completed",
      },
    ]);

    const retry = await service.retryTask(boardId, firstRun.taskId);
    expect(retry.status).toBe("accepted");
    expect(bridge.promptSessionAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: { modelID: "gpt-5", providerID: "openai" },
        text: "keep the active run stable",
      })
    );
  });
  test("provider dispatch failure leaves a visible failed card with its prompt", async () => {
    const bridge = makeMockBridge();
    bridge.promptSessionAsync.mockRejectedValue(
      new Error("provider unavailable")
    );
    const workspaceStore = makeWorkspaceStore("chorus-board-task-failure-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        reviewMode: "auto",
        text: "keep this prompt",
      })
    ).rejects.toMatchObject({ code: "prompt_dispatch_failed" });
    const failed = workspaceStore.getBoard(boardId)?.columns.done[0];

    expect(failed).toMatchObject({
      errorMessage: expect.stringContaining("could not confirm"),
      outcome: "failed",
      promptInput: { text: "keep this prompt" },
    });
    expect(workspaceStore.getBoard(boardId)?.session.errorMessage).toContain(
      "could not confirm"
    );
  });
});
