import { startPhase6Harness } from "./phase-6-harness";

const questionMode = process.env.CHORUS_BROWSER_FIXTURE_QUESTION;
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
const seedQuestionMode = questionCount > 0;
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

const harness = await startPhase6Harness({
  interactive: true,
  questionReplyDelayMs,
});
if (seedQuestionMode) {
  const boardId = harness.boardIds.at(-1);
  if (!boardId) {
    throw new Error("Question browser fixture has no board");
  }
  const run = await harness.queueInteractiveTask(
    boardId,
    "Choose how the scripted fixture should handle this task",
    "auto"
  );
  await harness.approvePermission(run.sessionId, `permission-${run.sessionId}`);
  for (let index = 0; index < questionCount; index += 1) {
    harness.engine.askQuestion(run.sessionId);
  }
}
let deltaIndex = 0;
let streamFailure: unknown;
let resolveShutdown: (() => void) | undefined;
const stopped = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
const streamTimer = setInterval(
  () => {
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
  },
  seedQuestionMode ? 200 : 30
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
