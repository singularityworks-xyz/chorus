import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBoard } from "@chorus/contracts";
import { WorkspaceStore } from "../workspace/store";
import {
  BoardTaskCommandError,
  BoardTaskService,
  GlobalModelNotConfiguredError,
  SessionOwnershipError,
} from "./board-task-service";

function makeMockBridge() {
  const session = {
    directory: "/tmp/repo",
    id: "sess-123",
    revert: undefined as { messageID: string } | undefined,
  };
  return {
    createSession: mock(async () => ({ id: "sess-123" })),
    forkSession: mock(async () => ({ id: "sess-forked" })),
    getSession: mock(async () => session),
    sessionMessages: mock(async () => [{ info: { role: "user" as const } }]),
    revertSession: mock(async () => ({ messageID: "message-1" })),
    unrevertSession: mock(async () => undefined),
    abortSession: mock(async () => true),
    waitForSessionIdle: mock(
      async (_sessionId: string, _directory: string, timeoutMs: number) =>
        timeoutMs > 0
    ),
    promptSession: mock(async () => undefined),
    promptSessionAsync: mock(async () => undefined),
    subscribeDirectory: mock(async () => undefined),
  };
}

const REPO = { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" };

/**
 * Board ids are server-generated (the client sends a seed and the store mints
 * the board), so fixtures read the id back off the commit instead of assuming
 * one. An earlier version of this file hard-coded "board-1" and the
 * session patch silently no-oped against a board that did not exist.
 */
async function seedBoard(
  workspaceStore: WorkspaceStore,
  session?: Partial<WorkspaceBoard["session"]>,
  repo: { directory: string; worktree: string } = REPO,
  configureGlobalModel = true
) {
  const created = await workspaceStore.applyMutation({
    baseRevision: null,
    clientId: "task-test",
    mutationId: `seed-${crypto.randomUUID()}`,
    payload: {
      seed: { repo: { ...repo, sandboxes: [] }, title: "Repo Board" },
    },
    type: "board.create",
  });

  const event = created?.events[0];
  if (!created || event?.type !== "board.created") {
    throw new Error("expected a board.created commit");
  }

  const boardId = event.board.boardId;

  if (configureGlobalModel) {
    await workspaceStore.applyMutation({
      baseRevision: null,
      clientId: "task-test",
      mutationId: `default-model-${crypto.randomUUID()}`,
      payload: { model: { providerID: "anthropic", modelID: "claude" } },
      type: "preference.default_model.set",
    });
  }

  if (session) {
    await workspaceStore.applyMutation({
      baseRevision: null,
      clientId: "task-test",
      mutationId: `session-${crypto.randomUUID()}`,
      payload: { boardId, session },
      type: "board.session.patch",
    });
  }

  return boardId;
}

async function addSavedTask(
  store: WorkspaceStore,
  boardId: string,
  taskId: string,
  text = "saved prompt"
) {
  await store.applyBoardEvents(boardId, [
    {
      boardId,
      column: "queue",
      task: {
        id: taskId,
        label: text,
        labelVariant: "info-light",
        promptInput: { reviewMode: "auto", text },
        title: text,
      },
      taskId,
      ts: Date.now(),
      type: "card.created",
    },
  ]);
}

async function createManualReviewTask(
  service: BoardTaskService,
  store: WorkspaceStore,
  boardId: string
) {
  const queued = await service.queuePrompt({
    boardId,
    directory: "/tmp/repo",
    text: "Implement the requested feature",
    reviewMode: "manual",
  });
  const timestamp = Date.now();
  await store.applyBoardEvents(boardId, [
    {
      boardId,
      model: "anthropic/claude",
      sessionId: queued.sessionId,
      startedAt: timestamp,
      taskId: queued.taskId,
      taskTitle: "Implement the requested feature",
      ts: timestamp,
      type: "run.started",
    },
    {
      boardId,
      ts: timestamp + 1,
      type: "session.idle",
    },
  ]);
  return queued;
}

async function createRunningTask(
  service: BoardTaskService,
  store: WorkspaceStore,
  boardId: string
) {
  const queued = await service.queuePrompt({
    boardId,
    directory: "/tmp/repo",
    text: "Implement the requested feature",
    reviewMode: "auto",
  });
  await store.applyBoardEvents(boardId, [
    {
      boardId,
      taskId: queued.taskId,
      ts: Date.now(),
      type: "card.started",
    },
    {
      boardId,
      model: "anthropic/claude",
      sessionId: queued.sessionId,
      startedAt: Date.now(),
      taskId: queued.taskId,
      taskTitle: "Implement the requested feature",
      ts: Date.now(),
      type: "run.started",
    },
  ]);
  return queued;
}

const NO_SUCH_BOARD = /no such board/;
const BOARD_IS_CLOSING = /board is closing/;

describe("BoardTaskService", () => {
  test("Stop waits for engine idle and marks the exact task aborted", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-task-stop-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);
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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("Stop leaves the task active when the engine refuses the abort", async () => {
    const bridge = makeMockBridge();
    bridge.abortSession.mockResolvedValue(false);
    const dir = mkdtempSync(join(tmpdir(), "chorus-task-stop-refused-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);
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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("Stop does not send a stale abort when the engine is already idle", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockImplementation(
      async (_id, _directory, timeout) => timeout === 0
    );
    const dir = mkdtempSync(join(tmpdir(), "chorus-task-stop-idle-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);
    const task = await createRunningTask(service, workspaceStore, boardId);

    await service.abortTask(boardId, task.taskId);

    expect(bridge.abortSession).not.toHaveBeenCalled();
    expect(
      workspaceStore
        .getBoard(boardId)
        ?.columns.done?.find((entry) => entry.id === task.taskId)?.outcome
    ).toBe("succeeded");

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("finalizes the exact task with its saved model and retains review edits", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-review-finalize-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);
    const task = await createManualReviewTask(service, workspaceStore, boardId);
    await workspaceStore.applyMutation({
      baseRevision: null,
      clientId: "review-test",
      mutationId: `questions-${crypto.randomUUID()}`,
      payload: {
        boardId,
        plan: "Initial plan",
        questions: ["Which approach should be used?"],
        taskId: task.taskId,
      },
      type: "board.task.plan.update",
    });
    await workspaceStore.applyMutation({
      baseRevision: null,
      clientId: "review-test",
      mutationId: `mode-${crypto.randomUUID()}`,
      payload: { boardId, reviewMode: "auto" },
      type: "board.review_mode.set",
    });

    const result = await service.finalizeReview(boardId, task.taskId, {
      answers: ["Use the safer approach"],
      plan: "The reviewed implementation plan",
    });

    expect(result.status).toBe("accepted");
    expect(bridge.promptSessionAsync).toHaveBeenLastCalledWith({
      agent: "build",
      directory: "/tmp/repo",
      model: { providerID: "anthropic", modelID: "claude" },
      sessionID: task.sessionId,
      text: expect.stringContaining(
        "Answers to plan questions:\n- Which approach should be used?: Use the safer approach"
      ),
    });
    const approvedTask = workspaceStore
      .getBoard(boardId)
      ?.columns.approve?.find((entry) => entry.id === task.taskId);
    expect(approvedTask).toMatchObject({
      plan: "The reviewed implementation plan",
      questionAnswers: ["Use the safer approach"],
      reviewApproved: true,
    });
    expect(workspaceStore.getBoard(boardId)?.session.currentTaskId).toBe(
      task.taskId
    );

    await workspaceStore.applyBoardEvents(boardId, [
      {
        boardId,
        ts: Date.now(),
        type: "session.idle",
      },
    ]);
    expect(
      workspaceStore
        .getBoard(boardId)
        ?.columns.done?.find((entry) => entry.id === task.taskId)?.outcome
    ).toBe("succeeded");

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("rejecting a plan aborts only that card and releases the board", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-review-reject-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);
    const task = await createManualReviewTask(service, workspaceStore, boardId);

    await expect(
      service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "A second task must wait",
        reviewMode: "auto",
      })
    ).rejects.toMatchObject({ code: "board_busy" });
    const result = await service.rejectReview(boardId, task.taskId);

    expect(result.accepted).toBe(true);
    expect(bridge.abortSession).not.toHaveBeenCalled();
    expect(bridge.promptSessionAsync).toHaveBeenCalledTimes(1);
    expect(
      workspaceStore
        .getBoard(boardId)
        ?.columns.done?.find((entry) => entry.id === task.taskId)?.outcome
    ).toBe("aborted");
    expect(
      workspaceStore.getBoard(boardId)?.session.currentTaskId
    ).toBeUndefined();

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("a failed review dispatch preserves edits and allows a safe retry", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-review-failed-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);
    const task = await createManualReviewTask(service, workspaceStore, boardId);
    bridge.promptSessionAsync.mockRejectedValueOnce(
      new Error("provider unavailable")
    );

    await expect(
      service.finalizeReview(boardId, task.taskId, {
        answers: [],
        plan: "Saved despite provider failure",
      })
    ).rejects.toMatchObject({ code: "prompt_dispatch_failed" });

    const board = workspaceStore.getBoard(boardId);
    const reviewTask = board?.columns.approve?.find(
      (entry) => entry.id === task.taskId
    );
    expect(reviewTask).toMatchObject({
      errorMessage: expect.stringContaining("Check the task stream"),
      plan: "Saved despite provider failure",
      questionAnswers: [],
      reviewApproved: false,
    });
    expect(board?.session.currentTaskId).toBeUndefined();
    expect(
      await service.finalizeReview(boardId, task.taskId, {
        answers: [],
        plan: "Saved despite provider failure",
      })
    ).toMatchObject({ status: "accepted", taskId: task.taskId });

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("runs the saved prompt for an explicitly targeted queued card once", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-run-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });
    await addSavedTask(
      workspaceStore,
      boardId,
      "task-run-1",
      "saved run prompt"
    );
    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("retry creates a child card with the persisted prompt", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-retry-"));
    const workspaceStore = new WorkspaceStore(dir);
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
    const service = new BoardTaskService(bridge as never, workspaceStore);

    const result = await service.retryTask(boardId, "task-finished-1");
    const retry = workspaceStore.getBoard(boardId)?.columns.queue[0];

    expect(result.status).toBe("accepted");
    expect(retry).toMatchObject({ retryOf: "task-finished-1" });
    expect(retry?.promptInput?.text).toBe("retry prompt");
    expect(bridge.promptSessionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ text: "retry prompt" })
    );

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("provider dispatch failure leaves a visible failed card with its prompt", async () => {
    const bridge = makeMockBridge();
    bridge.promptSessionAsync.mockRejectedValue(
      new Error("provider unavailable")
    );
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-failure-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });
    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("aborts the board session before committing removal", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-remove-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("concurrent removals share one abort and one durable operation", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-remove-concurrent-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);
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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("keeps the board when the engine cannot confirm abort", async () => {
    const bridge = makeMockBridge();
    bridge.abortSession.mockResolvedValue(false);
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-remove-failed-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("creates a session for the first prompt", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-create-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    const recoveredStore = new WorkspaceStore(dir);
    await recoveredStore.load();
    expect(
      recoveredStore.getBoard(boardId)?.columns.queue[0]?.promptInput
    ).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude" },
      reviewMode: "auto",
      text: "build feature",
    });
    await recoveredStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("uses one application model across boards despite client model overrides", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-global-model-"));
    const workspaceStore = new WorkspaceStore(dir);
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
    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("requires a global model before creating a session", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-no-global-model-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(
      workspaceStore,
      { state: "uninitialized" },
      REPO,
      false
    );
    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("reuses the persisted session for later prompts", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-reuse-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });

    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("binds the created session onto the board in the event log", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-bind-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);
    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "build feature",
      reviewMode: "auto",
    });

    // The session binding has to be durable, not just in-memory: a restart
    // mid-session must find it again.
    expect(workspaceStore.getBoard(boardId)?.session.sessionId).toBe(
      "sess-123"
    );
    await workspaceStore.close();

    const reopened = new WorkspaceStore(dir);
    await reopened.load();
    expect(reopened.getBoard(boardId)?.session.sessionId).toBe("sess-123");
    await reopened.close();

    rmSync(dir, { force: true, recursive: true });
  });
  test("queueing a prompt creates the card that agent events attach to", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-card-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);
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
    // The load-bearing part: without this the store has no task id to attach
    // agent events to, and every task-scoped event is dropped.
    expect(board?.session.currentTaskId).toBe(card?.id);

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("a second prompt on a live board is rejected rather than attached to that run", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-card2-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);
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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("a card is created even when the session was reused", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-card3-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "uninitialized",
    });

    const service = new BoardTaskService(bridge as never, workspaceStore);
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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });
  describe("session reuse is scoped to a directory (plan P6 task 3)", () => {
    /**
     * A session belongs to the tree it was opened in.
     *
     * The trigger is the *board's* directory changing — it gets reprovisioned onto
     * a new worktree — not the client asking for a different one. The service
     * resolves the working directory itself now, so a client cannot aim a prompt
     * anywhere; the registry's recorded directory is compared against the board's
     * current one.
     */
    test("same directory reuses the session", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-same-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge as never, workspaceStore);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "keep going",
        reviewMode: "auto",
      });

      expect(result.sessionId).toBe("sess-123");
      expect(result.createdSession).toBe(false);
      expect(bridge.forkSession).not.toHaveBeenCalled();

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a persisted session the engine places elsewhere forks", async () => {
      // The realistic shape: serve restarted, so the registry is empty, and the
      // stored session id turns out to belong to a different board's checkout.
      // Only the engine can answer that, so it is asked.
      const bridge = makeMockBridge();
      bridge.getSession.mockResolvedValue({
        directory: "/tmp/repo/.chorus-worktrees/some-other-board",
        id: "sess-123",
      } as never);
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-elsewhere-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge as never, workspaceStore);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "carry on",
        reviewMode: "auto",
      });

      expect(bridge.forkSession).toHaveBeenCalledWith({
        directory: "/tmp/repo",
        sessionID: "sess-123",
      });
      expect(result.sessionId).toBe("sess-forked");

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a persisted session the engine confirms in place is reused", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-confirmed-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge as never, workspaceStore);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "carry on",
        reviewMode: "auto",
      });

      expect(bridge.getSession).toHaveBeenCalled();
      expect(bridge.forkSession).not.toHaveBeenCalled();
      expect(result.sessionId).toBe("sess-123");
      expect(result.createdSession).toBe(false);

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("an engine lookup failure refuses unverified session reuse", async () => {
      const bridge = makeMockBridge();
      bridge.getSession.mockRejectedValue(new Error("engine unreachable"));
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-unreachable-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge as never, workspaceStore);

      await expect(
        service.queuePrompt({
          boardId,
          directory: "/tmp/repo",
          text: "carry on",
          reviewMode: "auto",
        })
      ).rejects.toBeInstanceOf(SessionOwnershipError);

      expect(bridge.forkSession).not.toHaveBeenCalled();
      expect(bridge.promptSessionAsync).not.toHaveBeenCalled();

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a trailing separator on the stored path is not a different directory", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-slash-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge as never, workspaceStore);

      await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "first",
        reviewMode: "auto",
      });
      const currentTaskId =
        workspaceStore.getBoard(boardId)?.session.currentTaskId;
      if (currentTaskId) {
        await workspaceStore.applyBoardEvents(boardId, [
          {
            boardId,
            taskId: currentTaskId,
            ts: Date.now(),
            type: "card.completed",
          },
        ]);
      }
      // The registry recorded `/tmp/repo`; the board now resolves through a
      // trailing separator. Same tree, so no fork.
      bridge.getSession.mockResolvedValue({
        directory: "/tmp/repo/",
        id: "sess-123",
      } as never);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "same tree, different spelling",
        reviewMode: "auto",
      });

      expect(bridge.forkSession).not.toHaveBeenCalled();
      expect(result.sessionId).toBe("sess-123");

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a client cannot redirect the agent to a directory it names", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-override-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge as never, workspaceStore);

      await service.queuePrompt({
        boardId,
        directory: "/somewhere/else",
        text: "not that way",
        reviewMode: "auto",
      });

      // The board's own checkout wins over whatever the caller asked for.
      expect(bridge.subscribeDirectory).toHaveBeenCalledWith("/tmp/repo");
      expect(bridge.forkSession).not.toHaveBeenCalled();

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a client cannot bind an unrelated session to the board", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-session-ownership-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge as never, workspaceStore);

      await expect(
        service.queuePrompt({
          boardId,
          directory: "/tmp/repo",
          sessionId: "sess-unrelated",
          text: "do not steal another session",
          reviewMode: "auto",
        })
      ).rejects.toMatchObject({ code: "session_ownership_conflict" });
      expect(bridge.getSession).not.toHaveBeenCalled();
      expect(bridge.promptSessionAsync).not.toHaveBeenCalled();

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });
  });

  describe("the agent runs in the board's own worktree", () => {
    /**
     * Regression: worktrees were created and recorded on the board but never used.
     * The client sends `repo.directory` with every prompt and the service passed it
     * straight through, so every agent ran in the primary checkout and two boards
     * on one repo shared an index — the exact collision worktree-per-board exists
     * to prevent. The service resolves the directory itself now.
     */
    test("a board with a worktree runs there, not in the primary checkout", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-worktree-bind-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      // What the store produces for the second board on a repo.
      const worktree = "/repos/app/.chorus-worktrees/board-7";
      const boardId = await seedBoard(
        workspaceStore,
        { state: "uninitialized" },
        { directory: "/repos/app", worktree }
      );

      const service = new BoardTaskService(bridge as never, workspaceStore);
      await service.queuePrompt({
        boardId,
        // What the client sends: the primary checkout.
        directory: "/repos/app",
        text: "do the work",
        reviewMode: "auto",
      });

      expect(bridge.subscribeDirectory).toHaveBeenCalledWith(worktree);
      expect(bridge.createSession).toHaveBeenCalledWith({
        directory: worktree,
        title: "do the work",
      });
      expect(bridge.promptSessionAsync).toHaveBeenCalledWith(
        expect.objectContaining({ directory: worktree })
      );

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a board with no worktree keeps the primary checkout", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-worktree-none-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        state: "uninitialized",
      });

      const service = new BoardTaskService(bridge as never, workspaceStore);
      await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "do the work",
        reviewMode: "auto",
      });

      expect(bridge.createSession).toHaveBeenCalledWith({
        directory: "/tmp/repo",
        title: "do the work",
      });

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });
  });
  test("two prompts queued at once dispatch only the first and reject the second", async () => {
    // Per-board operations serialize so a double submit cannot dispatch two
    // prompts into one session or pretend the second was queued.
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-card-race-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });
  test("a prompt for an unknown board is refused", async () => {
    // Previously the working directory fell back to whatever the caller sent, so a
    // token-holder could skip board creation entirely and point the engine at any
    // path on the host.
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-unknown-board-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });
  test("a prompt after a timed-out card creates a new one", async () => {
    // The failure this guards: `session.timeout` moves the card to `done` but used
    // to leave `currentTaskId` pointing at it, so the next prompt skipped card
    // creation and every new agent event attached to a finished card. A timeout is
    // the common way in, because no later `session.idle` arrives to release it.
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-after-timeout-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-1",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "first run",
      reviewMode: "auto",
    });
    const firstTaskId = workspaceStore.getBoard(boardId)?.session.currentTaskId;

    // The run dies without an idle.
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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("session history enables undo for an idle board session", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    const dir = mkdtempSync(join(tmpdir(), "chorus-session-history-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("an empty session has no undo action", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.sessionMessages.mockResolvedValue([]);
    const dir = mkdtempSync(join(tmpdir(), "chorus-session-empty-history-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

    await expect(
      service.getSessionHistoryState(boardId)
    ).resolves.toMatchObject({ canRedo: false, canUndo: false, busy: false });
    await expect(
      service.sessionHistoryCommand(boardId, "undo")
    ).rejects.toMatchObject({ code: "session_nothing_to_undo" });
    expect(bridge.revertSession).not.toHaveBeenCalled();

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
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
    const dir = mkdtempSync(join(tmpdir(), "chorus-session-command-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);
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

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("session history reports redo when OpenCode has an active revert", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.getSession.mockResolvedValue({
      directory: "/tmp/repo",
      id: "sess-123",
      revert: { messageID: "message-1" },
    });
    const dir = mkdtempSync(join(tmpdir(), "chorus-session-redo-state-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

    const state = await service.getSessionHistoryState(boardId);

    expect(state).toMatchObject({ canRedo: true, canUndo: false, busy: false });

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("session history refuses busy work without reverting the session", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(false);
    const dir = mkdtempSync(join(tmpdir(), "chorus-session-busy-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

    await expect(
      service.getSessionHistoryState(boardId)
    ).resolves.toMatchObject({ busy: true, canUndo: false, canRedo: false });
    await expect(
      service.sessionHistoryCommand(boardId, "undo")
    ).rejects.toMatchObject({ code: "session_busy" });
    expect(bridge.revertSession).not.toHaveBeenCalled();

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("session history refuses sessions owned by another checkout", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.getSession.mockResolvedValue({
      directory: "/tmp/other-repo",
      id: "sess-123",
      revert: undefined,
    });
    const dir = mkdtempSync(join(tmpdir(), "chorus-session-owner-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

    await expect(
      service.sessionHistoryCommand(boardId, "undo")
    ).rejects.toMatchObject({ code: "session_ownership_conflict" });
    expect(bridge.revertSession).not.toHaveBeenCalled();

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("session history failures return explicit retryable errors", async () => {
    const bridge = makeMockBridge();
    bridge.waitForSessionIdle.mockResolvedValue(true);
    bridge.revertSession.mockRejectedValue(new Error("engine unavailable"));
    const dir = mkdtempSync(join(tmpdir(), "chorus-session-history-failure-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });
    const service = new BoardTaskService(bridge as never, workspaceStore);

    await expect(
      service.sessionHistoryCommand(boardId, "undo")
    ).rejects.toMatchObject({ code: "session_command_failed" });

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });
});
