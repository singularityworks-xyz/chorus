import { startPhase6Harness } from "./phase-6-harness";

const reasoningDeltas = [
  " I’m checking the current board and task state.",
  " The selected model is shared across these boards.",
  " I’m tracing the requested action through its server command.",
  " The stream is arriving in ordered, incremental updates.",
];

const harness = await startPhase6Harness();
let deltaIndex = 0;
let streamFailure: unknown;
let resolveShutdown: (() => void) | undefined;
const stopped = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
const streamTimer = setInterval(() => {
  const delta = reasoningDeltas[deltaIndex % reasoningDeltas.length];
  deltaIndex += 1;
  if (delta) {
    try {
      harness.engine.appendActiveReasoningDelta(delta);
    } catch (error) {
      streamFailure = error;
      process.stderr.write(`Fixture stream stopped: ${String(error)}\n`);
      resolveShutdown?.();
    }
  }
}, 30);

process.stdout.write(
  `${JSON.stringify({
    accessToken: harness.accessToken,
    boardIds: harness.runs.map((run) => run.boardId),
    serveBaseUrl: harness.serveBaseUrl,
    webOrigin:
      process.env.CHORUS_BROWSER_FIXTURE_ORIGIN ?? "http://localhost:3001",
  })}\n`
);

await stopped;
clearInterval(streamTimer);
await harness.close();
// Shutdown is explicit above; OpenCode SDK/socket handles can still keep Bun's
// event loop alive after the servers are closed, so exit only after cleanup.
process.exit(streamFailure === undefined ? 0 : 1);
