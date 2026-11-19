import { describe, expect, test } from "bun:test";
import { BoardTaskService } from "../board-task-service";
import {
  createManualReviewTask,
  makeMockBridge,
  makeWorkspaceStore,
  seedBoard,
} from "../test-support";

describe("BoardTaskService", () => {
  test("finalizes the exact task with its saved model and retains review edits", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-review-finalize-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge, workspaceStore);
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
  });
  test("rejecting a plan aborts only that card and releases the board", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-review-reject-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge, workspaceStore);
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
  });
  test("a failed review dispatch preserves edits and allows a safe retry", async () => {
    const bridge = makeMockBridge();
    const workspaceStore = makeWorkspaceStore("chorus-review-failed-");
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      state: "uninitialized",
    });
    const service = new BoardTaskService(bridge, workspaceStore);
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
  });
});
