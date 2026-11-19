const port = Number(process.argv[2] ?? "2150");

interface Frame {
  data?: { v?: number };
  head?: number;
  seq?: number;
  type: string;
  workspaceId?: string;
}

interface TestClient {
  close: () => void;
  frames: Frame[];
  send: (payload: unknown) => void;
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<boolean>;
}

function openSocket(): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: Frame[] = [];

  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        close: () => socket.close(),
        frames,
        async waitFor(predicate, timeoutMs = 5000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (predicate()) {
              return true;
            }
            await Bun.sleep(40);
          }
          return predicate();
        },
        send: (payload: unknown) => socket.send(JSON.stringify(payload)),
      });
    });
    socket.addEventListener("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("ws error"));
    });
  });
}

const results: { detail: string; name: string; ok: boolean }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ detail, name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function seqsOf(client: TestClient): number[] {
  return client.frames
    .filter((f) => f.type === "event")
    .map((f) => f.seq as number);
}

function strictlyIncreasing(seqs: number[]): boolean {
  return seqs.every(
    (seq, index) => index === 0 || seq > (seqs[index - 1] as number)
  );
}

let mutationCounter = 0;
async function createBoard(title: string): Promise<number> {
  mutationCounter += 1;
  const response = await fetch(`http://127.0.0.1:${port}/workspace/mutations`, {
    body: JSON.stringify({
      baseRevision: null,
      clientId: "live-check",
      mutationId: `live-${Date.now()}-${mutationCounter}`,
      payload: {
        seed: {
          repo: {
            directory: "/tmp/repo",
            sandboxes: [],
            worktree: "/tmp/repo",
          },
          title,
        },
      },
      type: "board.create",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return response.status;
}

const clientA = await openSocket();
clientA.send({ since: 0, type: "hello" });
await clientA.waitFor(() => clientA.frames.some((f) => f.type === "snapshot"));

const clientB = await openSocket();
clientB.send({ since: 0, type: "hello" });
await clientB.waitFor(() => clientB.frames.some((f) => f.type === "snapshot"));

const readyFrame = clientA.frames.find((f) => f.type === "ready");
const snapshotFrame = clientA.frames.find((f) => f.type === "snapshot");
const workspaceId = readyFrame?.workspaceId;
if (!workspaceId) {
  throw new Error("serve did not provide a workspace identity");
}

record(
  "hello yields ready then a versioned snapshot",
  clientA.frames[0]?.type === "ready" &&
    typeof readyFrame?.head === "number" &&
    snapshotFrame?.data?.v === 1,
  `frames=${clientA.frames.map((f) => f.type).join(",")} head=${String(readyFrame?.head)} v=${String(snapshotFrame?.data?.v)}`
);

const headBefore = readyFrame?.head ?? 0;
clientA.frames.length = 0;
clientB.frames.length = 0;

const statusA = await createBoard("First");
const gotOnA = await clientA.waitFor(() => seqsOf(clientA).length >= 1);
const gotOnB = await clientB.waitFor(() => seqsOf(clientB).length >= 1);

record(
  "an HTTP mutation arrives as a sequenced event on every client",
  statusA === 200 &&
    gotOnA &&
    gotOnB &&
    seqsOf(clientA)[0] === headBefore + 1 &&
    JSON.stringify(seqsOf(clientA)) === JSON.stringify(seqsOf(clientB)),
  `http=${statusA} A=${JSON.stringify(seqsOf(clientA))} B=${JSON.stringify(seqsOf(clientB))} expectedFirst=${headBefore + 1}`
);

const statusB = await createBoard("Second");
await clientA.waitFor(() => seqsOf(clientA).length >= 2);
await clientB.waitFor(() => seqsOf(clientB).length >= 2);

record(
  "two connected clients receive an identical ordered event stream",
  statusB === 200 &&
    seqsOf(clientA).length >= 2 &&
    JSON.stringify(seqsOf(clientA)) === JSON.stringify(seqsOf(clientB)) &&
    strictlyIncreasing(seqsOf(clientA)),
  `A=${JSON.stringify(seqsOf(clientA))} B=${JSON.stringify(seqsOf(clientB))}`
);

const lastSeen = seqsOf(clientA).at(-1) as number;
clientA.close();
clientB.close();
await Bun.sleep(200);

const clientC = await openSocket();
clientC.send({ since: lastSeen, type: "hello", workspaceId });
await clientC.waitFor(() => clientC.frames.some((f) => f.type === "ready"));
await Bun.sleep(500);

record(
  "a caught-up reconnect receives ready and no redundant replay",
  clientC.frames[0]?.type === "ready" &&
    seqsOf(clientC).length === 0 &&
    clientC.frames.length === 1 &&
    clientC.frames[0]?.head === lastSeen,
  `frames=${clientC.frames.map((f) => f.type).join(",")} head=${String(clientC.frames[0]?.head)} lastSeen=${lastSeen}`
);
clientC.close();
await Bun.sleep(200);

const clientD = await openSocket();
clientD.send({ since: 1, type: "hello", workspaceId });
await clientD.waitFor(() => clientD.frames.some((f) => f.type === "event"));
await Bun.sleep(400);

record(
  "a small gap replays the missing events rather than a whole snapshot",
  seqsOf(clientD).length > 0 &&
    clientD.frames.some((f) => f.type === "snapshot") === false &&
    seqsOf(clientD)[0] === 2,
  `replayed=${JSON.stringify(seqsOf(clientD))} snapshot=${clientD.frames.some((f) => f.type === "snapshot")}`
);
clientD.close();

await Bun.sleep(150);
const clientE = await openSocket();
clientE.send({ since: lastSeen, type: "hello", workspaceId });
await clientE.waitFor(() => clientE.frames.some((f) => f.type === "ready"));
clientE.frames.length = 0;
clientE.send({ type: "resync" });
await clientE.waitFor(() => clientE.frames.some((f) => f.type === "snapshot"));
await Bun.sleep(200);

record(
  "resync returns a fresh snapshot on demand",
  clientE.frames.some((f) => f.type === "snapshot"),
  `frames=${clientE.frames.map((f) => f.type).join(",")}`
);
clientE.close();

await Bun.sleep(150);
const sender = await openSocket();
sender.send({ since: lastSeen, type: "hello", workspaceId });
await sender.waitFor(() => sender.frames.some((f) => f.type === "ready"));
const relay = await openSocket();
relay.send({ since: lastSeen, type: "hello", workspaceId });
await relay.waitFor(() => relay.frames.some((f) => f.type === "ready"));
await Bun.sleep(200);

sender.send({
  payload: { projectId: "p1", viewport: { x: 1, y: 2, zoom: 1 } },
  type: "viewport.sync",
});
const relayed = await relay.waitFor(() =>
  relay.frames.some((f) => f.type === "viewport.sync")
);

record(
  "viewport.sync relays to other clients without being sequenced",
  relayed && seqsOf(relay).length === 0,
  `relayed=${relayed} relaySeqs=${JSON.stringify(seqsOf(relay))}`
);

sender.close();
relay.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} live checks passed`
);
process.exit(failed.length === 0 ? 0 : 1);

export {};
