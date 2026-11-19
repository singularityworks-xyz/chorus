import { describe, expect, test } from "bun:test";
import { agentEvent, createStore, seedActiveBoard } from "./test-support";

describe("WorkspaceStore pending approvals", () => {
  test("accepted pending approval resumes the task atomically", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);

    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "edit",
        permissionID: "permission-1",
      })
    );

    expect(
      store.getBoard(boardId)?.columns.approve[0]?.pendingApproval?.requestId
    ).toBe("permission-1");
    expect(
      await store.resolvePendingApproval("sess-1", "permission-1", true)
    ).toBe(true);

    const resumedBoard = store.getBoard(boardId);
    expect(resumedBoard?.columns.approve).toHaveLength(0);
    expect(resumedBoard?.columns.in_progress[0]).toMatchObject({
      id: "task-1",
      pendingApprovals: [],
    });
    expect(
      resumedBoard?.columns.in_progress[0]?.pendingApproval
    ).toBeUndefined();
  });

  test("resolving one of several approvals keeps the task waiting", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);

    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "edit",
        permissionID: "permission-1",
      })
    );
    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "bash",
        permissionID: "permission-2",
      })
    );

    expect(
      await store.resolvePendingApproval("sess-1", "permission-2", true)
    ).toBe(true);
    const waitingBoard = store.getBoard(boardId);
    expect(waitingBoard?.columns.approve).toHaveLength(1);
    expect(waitingBoard?.columns.approve[0]).toMatchObject({
      id: "task-1",
      pendingApprovals: [{ requestId: "permission-1" }],
    });
    expect(waitingBoard?.columns.in_progress).toHaveLength(0);

    expect(
      await store.resolvePendingApproval("sess-1", "permission-1", true)
    ).toBe(true);
    const resumedBoard = store.getBoard(boardId);
    expect(resumedBoard?.columns.approve).toHaveLength(0);
    expect(resumedBoard?.columns.in_progress[0]).toMatchObject({
      id: "task-1",
      pendingApprovals: [],
    });
  });

  test("only one concurrent client can answer a pending approval", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "edit",
        permissionID: "permission-shared",
      })
    );

    let releaseAction: (() => void) | undefined;
    let markActionStarted: (() => void) | undefined;
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve;
    });
    let actionCalls = 0;
    const firstResponse = store.runPendingApprovalAction(
      "sess-1",
      "permission-shared",
      async () => {
        actionCalls += 1;
        markActionStarted?.();
        await actionGate;
        return true;
      },
      { accepts: (accepted) => accepted, resume: true }
    );

    await actionStarted;
    const secondResponse = await store.runPendingApprovalAction(
      "sess-1",
      "permission-shared",
      () => {
        actionCalls += 1;
        return Promise.resolve(true);
      },
      { accepts: (accepted) => accepted, resume: true }
    );
    expect(secondResponse).toEqual({ status: "already_resolving" });
    expect(actionCalls).toBe(1);

    releaseAction?.();
    expect(await firstResponse).toEqual({ status: "accepted", value: true });
    expect(store.getBoard(boardId)?.columns.in_progress[0]).toMatchObject({
      id: "task-1",
      pendingApprovals: [],
    });
  });

  test("failed provider responses leave requests retryable", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedActiveBoard(store);
    await store.applyAgentEvent(
      agentEvent({
        activity: "waiting_for_approval",
        permission: "edit",
        permissionID: "permission-retry",
      })
    );

    await expect(
      store.runPendingApprovalAction("sess-1", "permission-retry", () =>
        Promise.reject(new Error("provider unavailable"))
      )
    ).rejects.toThrow("provider unavailable");
    expect(
      store.getBoard(boardId)?.columns.approve[0]?.pendingApproval?.requestId
    ).toBe("permission-retry");

    const retried = await store.runPendingApprovalAction(
      "sess-1",
      "permission-retry",
      async () => true,
      { accepts: (accepted) => accepted, resume: true }
    );
    expect(retried).toEqual({ status: "accepted", value: true });
  });
});
