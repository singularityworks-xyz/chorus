import { expect, test } from "bun:test";
import { startPhase6Harness } from "./phase-6-harness";

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
