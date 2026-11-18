import { startPhase6Harness } from "./phase-6-harness";

const questionMode = process.env.CHORUS_BROWSER_FIXTURE_QUESTION;
const pendingPermissionMode =
  process.env.CHORUS_BROWSER_FIXTURE_PENDING_PERMISSION === "1";
let questionCount = 0;
switch (questionMode) {
  case "1":
    questionCount = 1;
    break;
  case "multi":
    questionCount = 2;
    break;
  default:
    break;
}
const seedTaskMode = questionCount > 0 || pendingPermissionMode;
const questionReplyDelayMs = Number(
  process.env.CHORUS_BROWSER_FIXTURE_QUESTION_REPLY_DELAY_MS ?? 0
);
const reasoningDeltas = [
  " Checking the current board and task state.",
  " The selected model is shared across these boards.",
  " Tracing the requested action through its server command.",
  " The stream is arriving in ordered, incremental updates.",
  " The visible response is keeping pace with the event stream.",
];
const reasoningByteLimit = Number(
  process.env.CHORUS_BROWSER_FIXTURE_REASONING_BYTES ?? 0
);
if (
  !Number.isSafeInteger(reasoningByteLimit) ||
  reasoningByteLimit < 0 ||
  reasoningByteLimit > 64 * 1024 * 1024
) {
  throw new RangeError(
    "CHORUS_BROWSER_FIXTURE_REASONING_BYTES must be an integer from 0 to 67108864"
  );
}
const fixtureWebPort = Number(
  process.env.CHORUS_BROWSER_FIXTURE_WEB_PORT ?? 3000
);
if (
  !Number.isSafeInteger(fixtureWebPort) ||
  fixtureWebPort < 1 ||
  fixtureWebPort > 65_535
) {
  throw new RangeError(
    "CHORUS_BROWSER_FIXTURE_WEB_PORT must be an integer from 1 to 65535"
  );
}
const fixtureServePort = Number(
  process.env.CHORUS_BROWSER_FIXTURE_SERVE_PORT ?? 0
);
if (
  !Number.isSafeInteger(fixtureServePort) ||
  fixtureServePort < 0 ||
  fixtureServePort > 65_535
) {
  throw new RangeError(
    "CHORUS_BROWSER_FIXTURE_SERVE_PORT must be an integer from 0 to 65535"
  );
}

function createReasoningChunk(size: number, index: number): string {
  const paragraph = `Reasoning segment ${String(index).padStart(6, "0")}: tracing board state, provider choice, and task history.\n\n`;
  return paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size);
}

const harness = await startPhase6Harness({
  interactive: true,
  localEntryWebPort: fixtureWebPort,
  servePort: fixtureServePort,
  rootDirectory: process.env.CHORUS_BROWSER_FIXTURE_ROOT,
  questionReplyDelayMs,
});
if (seedTaskMode) {
  const boardId = harness.boardIds.at(-1);
  if (!boardId) {
    throw new Error("Interactive browser fixture has no board");
  }
  const run = await harness.queueInteractiveTask(
    boardId,
    "Choose how the scripted fixture should handle this task",
    "auto"
  );
  if (!pendingPermissionMode) {
    await harness.approvePermission(
      run.sessionId,
      `permission-${run.sessionId}`
    );
  }
  for (let index = 0; index < questionCount; index += 1) {
    harness.engine.askQuestion(run.sessionId);
  }
}
let deltaIndex = 0;
let streamedBytes = 0;
let streamFailure: unknown;
let resolveShutdown: (() => void) | undefined;
let streamTimer: ReturnType<typeof setInterval>;
const stopped = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
streamTimer = setInterval(
  () => {
    const remainingBytes = reasoningByteLimit - streamedBytes;
    if (reasoningByteLimit > 0 && remainingBytes <= 0) {
      clearInterval(streamTimer);
      return;
    }

    const delta =
      reasoningByteLimit > 0
        ? createReasoningChunk(Math.min(16 * 1024, remainingBytes), deltaIndex)
        : reasoningDeltas[deltaIndex % reasoningDeltas.length];
    deltaIndex += 1;
    if (delta) {
      try {
        const appended = harness.engine.appendActiveReasoningDelta(delta);
        if (appended && reasoningByteLimit > 0) {
          streamedBytes += delta.length;
          if (streamedBytes >= reasoningByteLimit) {
            clearInterval(streamTimer);
            process.stdout.write(
              `Reasoning fixture emitted ${streamedBytes} bytes.\n`
            );
          }
        }
      } catch (error) {
        streamFailure = error;
        process.stderr.write(`Fixture stream stopped: ${String(error)}\n`);
        resolveShutdown?.();
      }
    }
  },
  seedTaskMode ? 200 : 30
);

process.stdout.write(
  `${JSON.stringify({
    accessToken: harness.accessToken,
    boardIds: harness.boardIds,
    mode: "interactive",
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
