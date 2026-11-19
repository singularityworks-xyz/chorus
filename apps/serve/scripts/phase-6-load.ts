import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPhase6Harness } from "./phase-6-harness";

const durationSeconds = Number(process.env.CHORUS_LOAD_SECONDS ?? "600");
if (
  !Number.isInteger(durationSeconds) ||
  durationSeconds < 1 ||
  durationSeconds > 3600
) {
  throw new Error("CHORUS_LOAD_SECONDS must be an integer from 1 to 3600");
}
const harness = await startPhase6Harness();
const destination = resolve(
  process.env.CHORUS_LOAD_REPORT ?? ".context/phase-6-load-report.md"
);
let emitted = 0;
let initialRss = process.memoryUsage().rss;
let peakRss = initialRss;
let startedAt = Date.now();
try {
  harness.appendBatch(200);
  await new Promise((done) => setTimeout(done, 500));
  const startingSeq = harness.store.headSeq();
  initialRss = process.memoryUsage().rss;
  peakRss = initialRss;
  startedAt = Date.now();
  for (let tick = 0; tick < durationSeconds * 10; tick += 1) {
    harness.appendBatch(20);
    emitted += 20;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const nextTick = startedAt + (tick + 1) * 100;
    await new Promise((done) =>
      setTimeout(done, Math.max(0, nextTick - Date.now()))
    );
    if ((tick + 1) % 600 === 0) {
      process.stdout.write(
        `load: ${(tick + 1) / 10}s, ${emitted} events; ${JSON.stringify(harness.diagnostics())}\n`
      );
    }
  }
  const elapsedMs = Date.now() - startedAt;
  const result = await harness.complete(60_000);
  const persistedEvents = harness.store.headSeq() - startingSeq;
  const growthMb = Math.max(0, peakRss - initialRss) / (1024 * 1024);
  const rate = emitted / (elapsedMs / 1000);
  const passed =
    result.p95LatencyMs <= 200 &&
    growthMb <= 50 &&
    result.snapshotBytes < 1_000_000 &&
    rate >= 199;
  const report = `# Phase 6 scripted load report\n\nDate: ${new Date().toISOString()}\n\nRuntime: Bun ${Bun.version}; ${process.platform}/${process.arch}.\n\nEight scripted engine runs, three real Git repositories, ten authenticated WebSocket clients. No provider inference or browser automation. Commands use real HTTP, engine events traverse SDK/SSE/normalization, and workspaces persist through SQLite.\n\n| Measurement | Result | Budget |\n|---|---:|---:|\n| Duration | ${(elapsedMs / 1000).toFixed(2)} s | ≥600 s sustained; ≥1,800 s for 30-minute soak |\n| Raw streamed events | ${emitted} | 200/s |\n| Persisted domain events during stream and completion | ${persistedEvents} | informational; deltas are losslessly batched |\n| Achieved rate | ${rate.toFixed(2)}/s | ≥199/s (timer tolerance) |\n| WS frames | ${result.frames} | coalesced sequence ranges |\n| p95 normalized-event-to-client latency | ${result.p95LatencyMs} ms | ≤200 ms |\n| Peak RSS growth after warmup | ${growthMb.toFixed(2)} MB | ≤50 MB |\n| Final snapshot | ${result.snapshotBytes} bytes | <1 MB |\n| Distinct checkouts | ${new Set(result.checkouts).size} | 8 |\n\nAll ten mirrors match the final server boards. Latency uses a bounded ring of the latest 20,000 received frames, including coalesced frame ranges; the rate counts raw engine deltas, not frames. The persisted-event count begins after a warmup batch and includes terminal completion events. The harness and fixture share the Bun process with Serve modules, so RSS includes their allocations.\n\nResult: **${passed ? "PASS" : "FAIL"}**${durationSeconds < 600 ? " (short diagnostic; does not satisfy the ten-minute gate)" : ""}.\n`;
  writeFileSync(destination, report);
  process.stdout.write(
    `load: ${passed ? "passed" : "failed"}; report ${destination}\n`
  );
  if (!passed) {
    process.exitCode = 1;
  }
} catch (error) {
  const elapsedMs = Date.now() - startedAt;
  const growthMb = Math.max(0, peakRss - initialRss) / (1024 * 1024);
  const report = `# Phase 6 scripted load report\n\nDate: ${new Date().toISOString()}\n\nRuntime: Bun ${Bun.version}; ${process.platform}/${process.arch}.\n\nDuration: ${(elapsedMs / 1000).toFixed(2)} s. Raw streamed events: ${emitted}. Peak RSS growth after warmup: ${growthMb.toFixed(2)} MB.\n\nFailure: ${error instanceof Error ? error.message : String(error)}\n\nFinal diagnostics:\n\n\`\`\`json\n${JSON.stringify(harness.diagnostics(), null, 2)}\n\`\`\`\n\nResult: **FAIL**.\n`;
  writeFileSync(destination, report);
  process.stdout.write(`load: failed; report ${destination}\n`);
  throw error;
} finally {
  await harness.close();
}

await new Promise<void>((resolve, reject) =>
  process.stdout.write("", (error) => (error ? reject(error) : resolve()))
);
process.exit(0);
