import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeAdapter } from "@chorus/oc-adapter";
import { startPhase6Harness, waitForQualification } from "./phase-6-harness";

test("eight scripted agent runs finish in isolated checkouts with ten converged WS mirrors", async () => {
  const harness = await startPhase6Harness();
  try {
    harness.appendBatch(400);
    const report = await harness.complete();
    expect(harness.runs).toHaveLength(8);
    expect(harness.mirrors).toHaveLength(10);
    expect(new Set(report.checkouts).size).toBe(8);
    expect(report.snapshotBytes).toBeLessThan(1_000_000);
    expect(report.frames).toBeGreaterThan(0);
  } finally {
    await harness.close();
  }
}, 30_000);

test("mirrors recover a network flap with ordered replay and live delivery", async () => {
  const harness = await startPhase6Harness();
  try {
    const recovering = [harness.mirrors[0], harness.mirrors[1]];
    if (!(recovering[0] && recovering[1])) {
      throw new Error("qualification fixture did not create recovery mirrors");
    }
    await Promise.all([
      harness.disconnectMirror(0),
      harness.disconnectMirror(1),
    ]);
    const cursors = recovering.map((mirror) => mirror.seq);
    harness.appendBatch(4);
    await waitForQualification(
      () => {
        const head = harness.store.headSeq();
        return (
          head > (cursors[0] ?? 0) &&
          harness.mirrors.slice(2).every((mirror) => mirror.seq === head)
        );
      },
      10_000,
      () => harness.diagnostics()
    );

    const replayHead = harness.store.headSeq();
    await Promise.all([harness.reconnectMirror(0), harness.reconnectMirror(1)]);
    await waitForQualification(
      () => recovering.every((mirror) => mirror.seq === replayHead),
      10_000,
      () => harness.diagnostics()
    );

    for (const [index, mirror] of recovering.entries()) {
      const cursor = cursors[index];
      if (cursor === undefined) {
        throw new Error("qualification mirror cursor was not recorded");
      }
      let expectedFromSeq = cursor + 1;
      for (const range of mirror.recentEventRanges) {
        expect(range.fromSeq).toBe(expectedFromSeq);
        expect(range.seq).toBeGreaterThanOrEqual(range.fromSeq);
        expectedFromSeq = range.seq + 1;
      }
      expect(expectedFromSeq - 1).toBe(replayHead);
      expect(mirror.error).toBeUndefined();
      expect(mirror.boards).toEqual(harness.store.getSnapshot().boards);
    }

    const beforeLiveDelta = harness.store.headSeq();
    harness.appendBatch(2);
    await waitForQualification(
      () => {
        const head = harness.store.headSeq();
        return (
          head > beforeLiveDelta &&
          harness.mirrors.every(
            (mirror) => !mirror.error && mirror.seq === head
          )
        );
      },
      10_000,
      () => harness.diagnostics()
    );
    for (const mirror of recovering) {
      expect(mirror.boards).toEqual(harness.store.getSnapshot().boards);
    }
  } finally {
    await harness.close();
  }
}, 30_000);

test("mirrors recover ordered replay after an abrupt TCP transport loss", async () => {
  const harness = await startPhase6Harness({ tcpFaultProxyMirrors: 2 });
  try {
    const recovering = [harness.mirrors[0], harness.mirrors[1]];
    if (!(recovering[0] && recovering[1])) {
      throw new Error("qualification fixture did not create recovery mirrors");
    }
    await Promise.all([
      harness.disconnectMirror(0),
      harness.disconnectMirror(1),
    ]);
    const cursors = recovering.map((mirror) => mirror.seq);
    harness.appendBatch(4);
    await waitForQualification(
      () => {
        const head = harness.store.headSeq();
        return (
          head > (cursors[0] ?? 0) &&
          harness.mirrors.slice(2).every((mirror) => mirror.seq === head)
        );
      },
      10_000,
      () => harness.diagnostics()
    );

    const replayHead = harness.store.headSeq();
    await Promise.all([harness.reconnectMirror(0), harness.reconnectMirror(1)]);
    await waitForQualification(
      () => recovering.every((mirror) => mirror.seq === replayHead),
      10_000,
      () => harness.diagnostics()
    );

    for (const [index, mirror] of recovering.entries()) {
      const cursor = cursors[index];
      if (cursor === undefined) {
        throw new Error("qualification mirror cursor was not recorded");
      }
      let expectedFromSeq = cursor + 1;
      for (const range of mirror.recentEventRanges) {
        expect(range.fromSeq).toBe(expectedFromSeq);
        expect(range.seq).toBeGreaterThanOrEqual(range.fromSeq);
        expectedFromSeq = range.seq + 1;
      }
      expect(expectedFromSeq - 1).toBe(replayHead);
      expect(mirror.error).toBeUndefined();
      expect(mirror.boards).toEqual(harness.store.getSnapshot().boards);
    }

    const beforeLiveDelta = harness.store.headSeq();
    harness.appendBatch(2);
    await waitForQualification(
      () => {
        const head = harness.store.headSeq();
        return (
          head > beforeLiveDelta &&
          harness.mirrors.every(
            (mirror) => !mirror.error && mirror.seq === head
          )
        );
      },
      10_000,
      () => harness.diagnostics()
    );
    for (const mirror of recovering) {
      expect(mirror.boards).toEqual(harness.store.getSnapshot().boards);
    }
  } finally {
    await harness.close();
  }
}, 30_000);

test("interactive browser fixture starts with idle boards and one shared default model", async () => {
  const harness = await startPhase6Harness({ interactive: true });
  try {
    const snapshot = harness.store.getSnapshot();
    expect(harness.runs).toHaveLength(0);
    expect(harness.boardIds).toHaveLength(8);
    expect(snapshot.preferences.defaultModelSelection).toEqual({
      modelID: "scripted",
      providerID: "fixture",
    });
    expect(snapshot.boards).toHaveLength(8);
    expect(
      snapshot.boards.every(
        (board) =>
          board.columns.queue.length === 0 &&
          board.columns.in_progress.length === 0 &&
          board.columns.approve.length === 0 &&
          board.columns.done.length === 0
      )
    ).toBe(true);
    expect(() => harness.appendBatch(1)).toThrow(
      "appendBatch requires prepopulated qualification runs"
    );
    await expect(harness.complete()).rejects.toThrow(
      "complete requires prepopulated qualification runs"
    );
  } finally {
    await harness.close();
  }
}, 30_000);

test("manual review streams a plan and finalizes into an approved build run", async () => {
  const harness = await startPhase6Harness({ interactive: true });
  try {
    const boardId = harness.boardIds[0];
    expect(boardId).toBeDefined();
    if (!boardId) {
      throw new Error("interactive fixture has no board");
    }

    const run = await harness.queueInteractiveTask(
      boardId,
      "Implement the requested change after plan review",
      "manual"
    );
    await waitForQualification(
      () =>
        harness.store
          .getBoard(boardId)
          ?.columns.approve.some((task) => task.id === run.taskId) ?? false,
      5000,
      () => harness.store.getBoard(boardId)?.columns
    );

    const reviewBoard = harness.store.getBoard(boardId);
    const reviewTask = reviewBoard?.columns.approve.find(
      (task) => task.id === run.taskId
    );
    if (!reviewTask) {
      throw new Error("manual review plan did not reach the approval lane");
    }
    expect(reviewTask?.plan).toContain("Inspect the affected board flow");
    expect(
      reviewTask?.run?.steps.some(
        (step) =>
          step.kind === "thinking" &&
          step.content?.includes("mapping a safe implementation sequence")
      )
    ).toBe(true);
    const checkout = reviewBoard?.repo.worktree ?? reviewBoard?.repo.directory;
    expect(checkout).toBeDefined();
    if (!checkout) {
      throw new Error("manual review board has no checkout");
    }
    expect(existsSync(join(checkout, "result.txt"))).toBe(false);

    const finalizedPlan = `${reviewTask.plan}\n\nUser refinement: preserve current board behavior.`;
    // Leave the plan idle longer than Bun's default HTTP idle timeout. The
    // scripted engine sends SSE heartbeats, and the real bridge's reconnect
    // reconciliation is registered in this harness, so plan review remains
    // usable even when a browser waits before continuing.
    await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
    await harness.finalizeReview(boardId, run.taskId, finalizedPlan);
    await waitForQualification(
      () => {
        const task = harness.store
          .getBoard(boardId)
          ?.columns.approve.find((candidate) => candidate.id === run.taskId);
        return Boolean(
          task?.reviewApproved && (task.pendingApprovals?.length ?? 0) > 0
        );
      },
      5000,
      () => harness.store.getBoard(boardId)?.columns
    );

    await harness.approvePermission(
      run.sessionId,
      `permission-${run.sessionId}`
    );
    await waitForQualification(
      () =>
        harness.store
          .getBoard(boardId)
          ?.columns.in_progress.some((task) => task.id === run.taskId) ?? false,
      5000,
      () => harness.store.getBoard(boardId)?.columns
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 950));
    harness.engine.appendActiveReasoningDelta(
      " Implementation reasoning is streaming after approval."
    );
    await waitForQualification(
      () => {
        const task = harness.store
          .getBoard(boardId)
          ?.columns.in_progress.find(
            (candidate) => candidate.id === run.taskId
          );
        return Boolean(
          task?.run?.steps.some(
            (step) =>
              step.kind === "thinking" &&
              step.content?.includes("Implementation reasoning is streaming")
          )
        );
      },
      5000,
      () => harness.store.getBoard(boardId)?.columns
    );
  } finally {
    await harness.close();
  }
}, 30_000);

test("concurrent scripted questions stay request-scoped until all are answered", async () => {
  const harness = await startPhase6Harness({ interactive: true });
  try {
    const boardId = harness.boardIds.at(-1);
    if (!boardId) {
      throw new Error("interactive fixture has no board");
    }

    const run = await harness.queueInteractiveTask(
      boardId,
      "Wait for the user to choose an implementation behavior",
      "auto"
    );
    await harness.approvePermission(
      run.sessionId,
      `permission-${run.sessionId}`
    );
    await waitForQualification(
      () =>
        harness.store
          .getBoard(boardId)
          ?.columns.in_progress.some((task) => task.id === run.taskId) ?? false
    );

    const requestIds = [
      harness.engine.askQuestion(run.sessionId),
      harness.engine.askQuestion(run.sessionId),
    ];
    await waitForQualification(() =>
      requestIds.every((requestId) =>
        harness.store
          .getBoard(boardId)
          ?.columns.approve.some((task) =>
            task.pendingApprovals?.some(
              (request) => request.requestId === requestId
            )
          )
      )
    );

    const board = harness.store.getBoard(boardId);
    const directory = board?.repo.worktree ?? board?.repo.directory;
    if (!directory) {
      throw new Error("question fixture board has no checkout");
    }
    const adapter = OpenCodeAdapter.from({
      baseUrl: harness.engine.baseUrl,
      directory,
    });
    expect(await adapter.questions.list()).toMatchObject([
      {
        id: requestIds[0],
        sessionID: run.sessionId,
        questions: [
          {
            header: "Implementation choice",
            question: "Which behavior should the scripted task keep?",
          },
        ],
      },
      {
        id: requestIds[1],
        sessionID: run.sessionId,
        questions: [
          {
            header: "Implementation choice 2",
            question: "Which behavior should request 2 keep?",
          },
        ],
      },
    ]);

    const secondResponse = await harness.replyInteractiveQuestion(
      run.sessionId,
      requestIds[1] ?? "missing-second-question",
      1
    );
    expect(secondResponse).toMatchObject({
      accepted: true,
      requestID: requestIds[1],
      sessionID: run.sessionId,
    });
    expect(await adapter.questions.list()).toMatchObject([
      { id: requestIds[0], sessionID: run.sessionId },
    ]);
    expect(
      harness.store
        .getBoard(boardId)
        ?.columns.done.some((task) => task.id === run.taskId)
    ).toBe(false);
    const waitingBoard = harness.store.getBoard(boardId);
    expect(
      waitingBoard?.columns.approve
        .find((task) => task.id === run.taskId)
        ?.pendingApprovals?.map((request) => request.requestId)
    ).toEqual([requestIds[0]]);
    expect(
      waitingBoard?.columns.in_progress.some((task) => task.id === run.taskId)
    ).toBe(false);

    const firstResponse = await harness.replyInteractiveQuestion(
      run.sessionId,
      requestIds[0] ?? "missing-first-question"
    );
    expect(firstResponse).toMatchObject({
      accepted: true,
      requestID: requestIds[0],
      sessionID: run.sessionId,
    });
    await waitForQualification(
      () =>
        harness.store
          .getBoard(boardId)
          ?.columns.done.some((task) => task.id === run.taskId) ?? false
    );
    expect(await adapter.questions.list()).toEqual([]);
    const responseText =
      harness.store
        .getBoard(boardId)
        ?.columns.done.find((task) => task.id === run.taskId)
        ?.run?.steps.map((step) => step.content ?? "")
        .join("\n") ?? "";
    expect(responseText).toContain(
      "The user chose: Preserve current behavior."
    );
    expect(responseText).toContain(
      "The user chose: Apply the requested change."
    );
  } finally {
    await harness.close();
  }
}, 30_000);

test("scripted provider catalog and reasoning deltas cross the real SDK and projector", async () => {
  const harness = await startPhase6Harness();
  try {
    const adapter = OpenCodeAdapter.from({
      baseUrl: harness.engine.baseUrl,
      directory: harness.root,
    });
    const catalog = await adapter.providers.listModels();
    expect(catalog).toMatchObject({
      defaultModel: { modelID: "scripted", providerID: "fixture" },
      models: [
        {
          connected: true,
          modelID: "scripted",
          name: "Scripted Model",
          providerID: "fixture",
          reasoning: true,
        },
      ],
    });

    const run = harness.runs[0];
    expect(run).toBeDefined();
    if (!run) {
      throw new Error("qualification fixture did not create its first run");
    }
    harness.engine.appendReasoningDelta(
      run.sessionId,
      " Checking the board state."
    );
    await waitForQualification(
      () => {
        const board = harness.store.getBoard(run.boardId);
        return Boolean(
          board?.columns.in_progress.some((task) =>
            task.run?.steps.some(
              (step) =>
                step.kind === "thinking" &&
                step.content?.includes("Checking the board state.")
            )
          )
        );
      },
      5000,
      () => harness.store.getBoard(run.boardId)?.columns
    );
  } finally {
    await harness.close();
  }
}, 30_000);
