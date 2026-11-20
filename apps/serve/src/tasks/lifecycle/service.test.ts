import { describe, expect, test } from "bun:test";
import { BoardTaskService } from "../board-task-service";
import {
  BOARD_IS_CLOSING,
  createRunningTask,
  makeMockBridge,
  makeWorkspaceStore,
  seedBoard,
} from "../test-support";

describe("BoardTaskService", () => {
  test("Stop waits for engine idle and marks the exact task aborted", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-task-stop-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge, workspaceStore);
    const task = await createRunningTask(service, workspaceStore, boardId);

    const result = await service.abortTask(boardId, task.taskId);

    expect(result.status).toBe("accepted");
    expect(bridge.abortSession).toHaveBeenCalledWith(
      task.sessionId,
      "/tmp/repo"
    );
    expect(
      workspaceStore
        .getBoard(boardId)
        ?.columns.done?.find((entry) => entry.id === task.taskId)?.outcome
    ).toBe("aborted");
    expect(
      workspaceStore.getBoard(boardId)?.session.currentTaskId
    ).toBeUndefined();
  });
  test("Stop leaves the task active when the engine refuses the abort", async () => {
    const bridge = makeMockBridge();
    bridge.abortSession.mockResolvedValue(false);
    const workspaceStore = makeWorkspaceStore("chorus-task-stop-refused-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge, workspaceStore);
    const task = await createRunningTask(service, workspaceStore, boardId);

    await expect(service.abortTask(boardId, task.taskId)).rejects.toMatchObject(
      {
        code: "abort_not_accepted",
      }
    );
    const board = workspaceStore.getBoard(boardId);
    expect(board?.session.currentTaskId).toBe(task.taskId);
    expect(
      board?.columns.in_progress?.find((entry) => entry.id === task.taskId)
        ?.outcome
    ).toBeUndefined();
  });
  test("Stop does not send a stale abort when the engine is already idle", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockImplementation(
      async (_id, _directory, timeout) => timeout === 0
    );
    const workspaceStore = makeWorkspaceStore("chorus-task-stop-idle-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge, workspaceStore);
    const task = await createRunningTask(service, workspaceStore, boardId);

    await service.abortTask(boardId, task.taskId);

    expect(bridge.abortSession).not.toHaveBeenCalled();
    expect(
      workspaceStore
        .getBoard(boardId)
        ?.columns.done?.find((entry) => entry.id === task.taskId)?.outcome
    ).toBe("succeeded");
  });
  test("aborts the board session before committing removal", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-board-remove-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await service.removeBoard({
      baseRevision: null,
      clientId: "remove-test",
      mutationId: crypto.randomUUID(),
      payload: { boardId },
      type: "board.remove",
    });

    expect(bridge.abortSession).toHaveBeenCalledWith("sess-123", "/tmp/repo");
    expect(bridge.waitForSessionIdle).toHaveBeenCalledTimes(2);
    expect(workspaceStore.getBoard(boardId)).toBeUndefined();
  });
  test("concurrent removals share one abort and one durable operation", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore(
      "chorus-board-remove-concurrent-"
    );
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);
    let startAbort: () => void = () => undefined;
    let finishAbort: () => void = () => undefined;
    const abortStarted = new Promise<void>((resolvePromise) => {
      startAbort = resolvePromise;
    });
    const abortGate = new Promise<void>((resolvePromise) => {
      finishAbort = resolvePromise;
    });
    bridge.abortSession.mockImplementation(async () => {
      startAbort();
      await abortGate;
      return true;
    });
    const firstMutation = {
      baseRevision: null,
      clientId: "remove-test",
      mutationId: crypto.randomUUID(),
      payload: { boardId },
      type: "board.remove" as const,
    };
    const first = service.removeBoard(firstMutation);
    await abortStarted;
    const second = service.removeBoard({
      ...firstMutation,
      mutationId: crypto.randomUUID(),
    });

    expect(() => service.assertBoardOpen(boardId)).toThrow(BOARD_IS_CLOSING);
    finishAbort();
    const [firstCommit, secondCommit] = await Promise.all([first, second]);
    expect(firstCommit).toBe(secondCommit);
    expect(bridge.abortSession).toHaveBeenCalledTimes(1);
    expect(workspaceStore.getBoard(boardId)).toBeUndefined();
  });
  test("keeps the board when the engine cannot confirm abort", async () => {
    const bridge = makeMockBridge();
    bridge.abortSession.mockResolvedValue(false);
    const workspaceStore = makeWorkspaceStore("chorus-board-remove-failed-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge, workspaceStore);

    await expect(
      service.removeBoard({
        baseRevision: null,
        clientId: "remove-test",
        mutationId: crypto.randomUUID(),
        payload: { boardId },
        type: "board.remove",
      })
    ).rejects.toMatchObject({ code: "board_abort_failed" });
    expect(workspaceStore.getBoard(boardId)).toBeDefined();
  });
});
