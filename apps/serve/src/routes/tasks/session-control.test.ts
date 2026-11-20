import { describe, expect, test } from "bun:test";
import { BOARD_WORKTREE, makeApp } from "../test-support";

describe("POST /tasks/:sessionID/approve", () => {
  test("approves a permission request", async () => {
    const { app, bridge, resolvePendingApproval } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-1/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: "perm-1" }),
      })
    );

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      sessionID: "sess-1",
      requestID: "perm-1",
      accepted: true,
      timestamp: expect.any(Number),
    });

    expect(bridge.replyPermission).toHaveBeenCalledWith({
      directory: BOARD_WORKTREE,
      requestID: "perm-1",
      sessionID: "sess-1",
      reply: "once",
      message: undefined,
    });
    expect(resolvePendingApproval).toHaveBeenCalledWith(
      "sess-1",
      "perm-1",
      true
    );
  });

  test("passes optional message", async () => {
    const { app, bridge } = makeApp();

    await app.handle(
      new Request("http://localhost/tasks/sess-1/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: "perm-1", message: "approved" }),
      })
    );

    expect(bridge.replyPermission).toHaveBeenCalledWith({
      directory: BOARD_WORKTREE,
      requestID: "perm-1",
      sessionID: "sess-1",
      reply: "once",
      message: "approved",
    });
  });

  test("rejects missing requestID", async () => {
    const { app } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-1/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );

    expect(res.status).toBe(422);
  });
});
describe("POST /tasks/:sessionID/reject", () => {
  test("rejects a permission request", async () => {
    const { app, bridge } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-1/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: "perm-1" }),
      })
    );

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      sessionID: "sess-1",
      requestID: "perm-1",
      accepted: true,
      timestamp: expect.any(Number),
    });

    expect(bridge.replyPermission).toHaveBeenCalledWith({
      requestID: "perm-1",
      directory: BOARD_WORKTREE,
      sessionID: "sess-1",
      reply: "reject",
      message: undefined,
    });
  });
});
describe("question commands", () => {
  test("answers a question with an explicit accepted acknowledgment", async () => {
    const { app, bridge, resolvePendingApproval, runPendingApprovalAction } =
      makeApp();

    const response = await app.handle(
      new Request("http://localhost/tasks/sess-1/questions/question-1/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answers: [{ questionIndex: 0, optionIndices: [1], customAnswer: "" }],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: true,
      requestID: "question-1",
      sessionID: "sess-1",
      timestamp: expect.any(Number),
    });
    expect(bridge.replyQuestion).toHaveBeenCalledWith({
      answers: [{ questionIndex: 0, optionIndices: [1], customAnswer: "" }],
      directory: BOARD_WORKTREE,
      requestID: "question-1",
    });
    expect(resolvePendingApproval).toHaveBeenCalledWith(
      "sess-1",
      "question-1",
      true
    );
    expect(runPendingApprovalAction).toHaveBeenCalledTimes(1);
  });

  test("reports a conflict when another client is already answering", async () => {
    const { app, bridge, runPendingApprovalAction } = makeApp();
    runPendingApprovalAction.mockImplementation(async () => ({
      status: "already_resolving",
    }));

    const response = await app.handle(
      new Request("http://localhost/tasks/sess-1/questions/question-1/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: [] }),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "pending_approval_conflict",
      message:
        "Another client is already responding to this request. Wait for the board to sync before trying again.",
    });
    expect(bridge.replyQuestion).not.toHaveBeenCalled();
  });

  test("keeps a question pending when OpenCode declines the reply", async () => {
    const { app, bridge, resolvePendingApproval } = makeApp();
    bridge.replyQuestion.mockImplementation(async () => false);

    const response = await app.handle(
      new Request("http://localhost/tasks/sess-1/questions/question-1/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answers: [{ questionIndex: 0, optionIndices: [1] }],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect(resolvePendingApproval).not.toHaveBeenCalled();
  });

  test("rejects a question with an explicit accepted acknowledgment", async () => {
    const { app, bridge } = makeApp();

    const response = await app.handle(
      new Request("http://localhost/tasks/sess-1/questions/question-1/reject", {
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: true,
      requestID: "question-1",
      sessionID: "sess-1",
      timestamp: expect.any(Number),
    });
    expect(bridge.rejectQuestion).toHaveBeenCalledWith(
      "question-1",
      BOARD_WORKTREE
    );
  });

  test("keeps a question pending when OpenCode declines the rejection", async () => {
    const { app, bridge, resolvePendingApproval } = makeApp();
    bridge.rejectQuestion.mockImplementation(async () => false);

    const response = await app.handle(
      new Request("http://localhost/tasks/sess-1/questions/question-1/reject", {
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect(resolvePendingApproval).not.toHaveBeenCalled();
  });
});
describe("POST /tasks/:sessionID/abort", () => {
  test("resolves the current board task and uses the task lifecycle command", async () => {
    const { app, boardTasks, bridge } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-1/abort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      boardId: "board-1",
      taskId: "task-1",
      sessionId: "sess-123",
      status: "accepted",
      sessionID: "sess-1",
      accepted: true,
      timestamp: expect.any(Number),
    });

    expect(boardTasks.abortTask).toHaveBeenCalledWith("board-1", "task-1");
    expect(bridge.abortSession).not.toHaveBeenCalled();
  });

  test("refuses a session no board owns", async () => {
    const { app, bridge } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-unknown/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: "perm-1" }),
      })
    );

    expect(res.status).toBe(404);
    expect(bridge.replyPermission).not.toHaveBeenCalled();
  });

  test("rejects missing sessionID param", async () => {
    const { app } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks//abort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );

    expect(res.status).toBe(404);
  });
});
describe("POST /tasks/:sessionID/redirect", () => {
  test("soft redirect prompts the same session", async () => {
    const { app, bridge } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-1/redirect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "change approach", mode: "soft" }),
      })
    );

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      sessionID: "sess-1",
      mode: "soft",
      timestamp: expect.any(Number),
    });

    expect(bridge.promptSession).toHaveBeenCalledWith({
      directory: BOARD_WORKTREE,
      sessionID: "sess-1",
      text: "Redirect instruction: change approach",
    });
  });

  test("hard redirect forks the session", async () => {
    const { app, bridge, updateBoardSession } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-1/redirect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "start fresh", mode: "hard" }),
      })
    );

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      originalSessionID: "sess-1",
      newSessionID: "sess-forked",
      mode: "hard",
      timestamp: expect.any(Number),
    });

    expect(bridge.forkSession).toHaveBeenCalledWith({
      directory: BOARD_WORKTREE,
      sessionID: "sess-1",
    });

    expect(bridge.promptSession).toHaveBeenCalledWith({
      directory: BOARD_WORKTREE,
      sessionID: "sess-forked",
      text: "start fresh",
    });

    expect(updateBoardSession).toHaveBeenCalledWith("board-1", {
      sessionId: "sess-forked",
      state: "active",
    });
  });

  test("rejects invalid mode", async () => {
    const { app } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-1/redirect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "test", mode: "invalid" }),
      })
    );

    expect(res.status).toBe(422);
  });

  test("rejects missing text", async () => {
    const { app } = makeApp();

    const res = await app.handle(
      new Request("http://localhost/tasks/sess-1/redirect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "soft" }),
      })
    );

    expect(res.status).toBe(422);
  });
});
