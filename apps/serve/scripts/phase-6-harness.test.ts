import { expect, test } from "bun:test";
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
