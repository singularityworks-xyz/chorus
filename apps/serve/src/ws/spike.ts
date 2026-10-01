/**
 * Day-1 backpressure spike (plan Phase 3) — **measured through Elysia**.
 *
 * An earlier revision of this harness drove `Bun.serve` directly and concluded
 * that `send()`'s return value was useless (always a positive byte count). That
 * was measuring the wrong layer: Elysia wraps the socket and its context
 * documents a *different* contract — `-1` for backpressure, `0` for dropped,
 * `>0` for bytes sent. This harness measures the layer the hub actually runs on.
 *
 * It also establishes two facts the hub depends on and that are not in any type
 * definition: the handler context carries a stable `id` string (usable as the
 * registry key, because Elysia hands `open`, `message`, and `close` *different
 * wrapper objects* for the same connection), and `ctx.raw` exposes
 * `getBufferedAmount()` even though the context itself does not.
 *
 * Run with: `bun run apps/serve/src/ws/spike.ts`
 * Findings: .context/ws-backpressure-spike.md
 */

import { Elysia } from "elysia";

const PORT = Number(process.env.SPIKE_PORT ?? 2193);
const MESSAGES = Number(process.env.SPIKE_MESSAGES ?? 3000);
const PAYLOAD_BYTES = Number(process.env.SPIKE_PAYLOAD_BYTES ?? 8 * 1024);

interface SpikeResult {
  contextIdIsStableString: boolean;
  contextIdSample: unknown;
  /** Context members relevant to backpressure, for the record. */
  contextMembers: string[];
  maxBufferedBytes: number;
  rawExposesGetBufferedAmount: boolean;
  sendReturns: Record<string, number>;
}

const sendReturns = new Map<string, number>();
let maxBufferedBytes = -1;
let rawExposesGetBufferedAmount = false;
let contextIdSample: unknown;
let contextMembers: string[] = [];

function ownNames(value: unknown): string[] {
  const names = new Set<string>();
  let current = value as object | null;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      names.add(name);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names].sort();
}

const app = new Elysia().ws("/spike", {
  open(ctx) {
    const raw = (ctx.raw ?? {}) as { getBufferedAmount?: () => number };
    rawExposesGetBufferedAmount = typeof raw.getBufferedAmount === "function";
    contextMembers = ownNames(ctx);
    contextIdSample = ctx.id;

    const payload = "x".repeat(PAYLOAD_BYTES);

    for (let index = 0; index < MESSAGES; index += 1) {
      const status = ctx.send(`${index}::${payload}`);
      const key = String(status);
      sendReturns.set(key, (sendReturns.get(key) ?? 0) + 1);

      if (rawExposesGetBufferedAmount && raw.getBufferedAmount) {
        try {
          maxBufferedBytes = Math.max(
            maxBufferedBytes,
            raw.getBufferedAmount()
          );
        } catch {
          // Some builds expose the member without it being callable; the
          // send() status is the signal that matters.
        }
      }
    }
  },
  message() {
    return;
  },
});

app.listen(PORT);

// A client that connects and deliberately stops draining, so the server socket
// backs up and `send()` has to start reporting congestion.
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/spike`);
let received = 0;
socket.addEventListener("message", () => {
  received += 1;
});

await new Promise<void>((resolve) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", () => resolve());
  setTimeout(resolve, 5000);
});

await Bun.sleep(1200);

const result: SpikeResult = {
  contextIdIsStableString: typeof contextIdSample === "string",
  contextIdSample,
  maxBufferedBytes,
  rawExposesGetBufferedAmount,
  sendReturns: Object.fromEntries(sendReturns),
  contextMembers,
};

console.log(
  JSON.stringify(
    {
      ...result,
      messagesAttempted: MESSAGES,
      payloadBytes: PAYLOAD_BYTES,
      received,
    },
    null,
    2
  )
);

socket.close();
await app.stop(true);
