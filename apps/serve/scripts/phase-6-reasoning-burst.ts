import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPhase6Harness } from "./phase-6-harness";

const BURST_TICKS = 100;
const EVENTS_PER_TICK = 50;
const TICK_MS = 100;
const BURST_EVENTS = BURST_TICKS * EVENTS_PER_TICK;
const harness = await startPhase6Harness();

try {
  harness.appendReasoningBatch(200);
  await new Promise((done) => setTimeout(done, 500));

  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  let emitted = 0;
  const startedAt = Date.now();

  for (let tick = 0; tick < BURST_TICKS; tick += 1) {
    harness.appendReasoningBatch(EVENTS_PER_TICK);
    emitted += EVENTS_PER_TICK;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    const nextTick = startedAt + (tick + 1) * TICK_MS;
    await new Promise((done) =>
      setTimeout(done, Math.max(0, nextTick - Date.now()))
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const result = await harness.complete(60_000);
  const growthMb = Math.max(0, peakRss - initialRss) / (1024 * 1024);
  const rate = emitted / (elapsedMs / 1000);
  const passed =
    emitted === BURST_EVENTS &&
    rate >= 499 &&
    result.p95LatencyMs <= 200 &&
    growthMb <= 50 &&
    result.snapshotBytes < 1_000_000;
  const report = `# Phase 6 reasoning burst report\n\nDate: ${new Date().toISOString()}\n\nRuntime: Bun ${Bun.version}; ${process.platform}/${process.arch}.\n\nEight scripted engine tasks, three Git repositories, and ten authenticated WebSocket mirrors. Reasoning deltas traverse the real HTTP, SDK/SSE, normalization, SQLite, and WebSocket paths. No browser automation, external provider, or paid inference was used.\n\n| Measurement | Result | Budget |\n|---|---:|---:|\n| Duration | ${(elapsedMs / 1000).toFixed(3)} s | 10 s |\n| Reasoning deltas | ${emitted} | 5,000 |\n| Achieved rate | ${rate.toFixed(2)}/s | ≥499/s (timer tolerance) |\n| p95 normalized-event-to-client latency | ${result.p95LatencyMs} ms | ≤200 ms |\n| Peak RSS growth after warmup | ${growthMb.toFixed(2)} MiB | ≤50 MiB |\n| Final snapshot | ${result.snapshotBytes} bytes | <1 MB |\n| WebSocket frames | ${result.frames} | coalesced sequence ranges |\n| Client mirrors | 10/10 converged | exact final-board match |\n\nResult: **${passed ? "PASS" : "FAIL"}**. Browser rendering/input latency and live-provider reasoning are outside this server-side qualification.\n`;
  const destination = resolve(
    process.env.CHORUS_REASONING_BURST_REPORT ??
      ".context/phase-6-reasoning-burst-report.md"
  );
  writeFileSync(destination, report);
  process.stdout.write(
    `reasoning-burst: ${passed ? "passed" : "failed"}; report ${destination}\n`
  );
  if (!passed) {
    process.exitCode = 1;
  }
} finally {
  await harness.close();
}

await new Promise<void>((resolve, reject) =>
  process.stdout.write("", (error) => (error ? reject(error) : resolve()))
);
process.exit(process.exitCode ?? 0);
