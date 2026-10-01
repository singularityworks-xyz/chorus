/**
 * Day-1 backpressure spike (plan Phase 3).
 *
 * Answers three questions the hub design depends on, empirically, before any
 * production code exists:
 *
 *   1. What does `ws.send()` return when the socket buffer is full?
 *   2. Does the `drain` lifecycle hook fire reliably, and how early?
 *   3. Does the buffer actually recover once the reader resumes — i.e. would a
 *      "critical-only until drained" flag ever clear?
 *
 * Run with: `bun run apps/serve/scripts/ws-backpressure-spike.ts`
 * Findings are recorded in `.context/ws-backpressure-spike.md` and summarised
 * in the header comment of `apps/serve/src/ws/hub.ts`.
 *
 * Not shipped: imported by nothing, excluded from the app build.
 */

const PORT = 2199;
const MESSAGE_COUNT = 4000;
const PAYLOAD_BYTES = 8 * 1024;
const STALL_MS = 1500;

interface ServerSocket {
  getBufferedAmount: () => number;
  send: (data: string) => number;
}

const samples: { at: number; buffered: number }[] = [];
let drainFired = 0;
let bufferedAtFirstDrain: number | null = null;
let maxBuffered = 0;
let firstSendReturn: unknown;
const sendReturnTypes = new Map<string, number>();

const sockets = new Set<ServerSocket>();

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req, serverInstance) {
    if (serverInstance.upgrade(req)) {
      return;
    }
    return new Response("ok");
  },
  websocket: {
    // Unused by the spike, but Bun's handler type requires the full surface.
    message() {
      return;
    },
    open(ws) {
      const socket = ws as unknown as ServerSocket;
      sockets.add(socket);
      samples.push({ at: Date.now(), buffered: 0 });

      const payload = "x".repeat(PAYLOAD_BYTES);

      for (let index = 0; index < MESSAGE_COUNT; index += 1) {
        const returned = socket.send(`${index}::${payload}`);
        const buffered = socket.getBufferedAmount();
        maxBuffered = Math.max(maxBuffered, buffered);

        const key = typeof returned;
        sendReturnTypes.set(key, (sendReturnTypes.get(key) ?? 0) + 1);
        if (firstSendReturn === undefined) {
          firstSendReturn = returned;
        }
      }

      samples.push({ at: Date.now(), buffered: socket.getBufferedAmount() });
    },
    drain(ws) {
      drainFired += 1;
      if (bufferedAtFirstDrain === null) {
        bufferedAtFirstDrain = (
          ws as unknown as ServerSocket
        ).getBufferedAmount();
      }
    },
  },
});

const socket = new WebSocket(`ws://127.0.0.1:${PORT}/`);
let clientMessagesReceived = 0;

// Phase 1 — connect and deliberately stop reading to stall the server socket.
socket.addEventListener("message", () => {
  clientMessagesReceived += 1;
});

await new Promise<void>((resolve) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", () => resolve());
  setTimeout(resolve, 5000);
});

await Bun.sleep(STALL_MS);

const activeSocket = [...sockets][0];
const stalledBuffered = activeSocket?.getBufferedAmount() ?? -1;
const drainFiredDuringStall = drainFired;

// Sample the live buffer while the reader is still stalled.
for (let tick = 0; tick < 5; tick += 1) {
  await Bun.sleep(200);
  samples.push({
    at: Date.now(),
    buffered: activeSocket?.getBufferedAmount() ?? -1,
  });
}

// Phase 2 — resume reading by pulling events, and watch the buffer fall.
socket.addEventListener("message", () => {
  clientMessagesReceived += 1;
});

let recoveredToZero = false;
for (let tick = 0; tick < 40; tick += 1) {
  await Bun.sleep(150);
  const buffered = activeSocket?.getBufferedAmount() ?? -1;
  samples.push({ at: Date.now(), buffered });
  if (buffered === 0) {
    recoveredToZero = true;
    break;
  }
}

const finalBuffered = activeSocket?.getBufferedAmount() ?? -1;

console.log(
  JSON.stringify(
    {
      sendReturnType: typeof firstSendReturn,
      sendReturnExample: firstSendReturn,
      sendReturnTypes: Object.fromEntries(sendReturnTypes),
      messagesAttempted: MESSAGE_COUNT,
      payloadBytes: PAYLOAD_BYTES,
      maxBufferedBytes: maxBuffered,
      stalledBufferedBytes: stalledBuffered,
      drainFiredDuringStall,
      drainFiredTotal: drainFired,
      bufferedAtFirstDrainBytes: bufferedAtFirstDrain,
      clientMessagesReceived,
      recoveredToZero,
      finalBufferedBytes: finalBuffered,
      bufferSamples: samples,
    },
    null,
    2
  )
);

socket.close();
await server.stop(true);

export {};
