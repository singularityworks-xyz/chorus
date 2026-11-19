import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../../workspace/store";
import type { WorkspaceHub } from "../hub";
import type { HubSocket } from "./types";

export interface FakeSocket extends HubSocket {
  buffered: number;
  closeCalls: { code?: number; reason?: string }[];
  getBufferedAmount: () => number;
  messages: Record<string, unknown>[];
  sent: string[];
}

const directories = new Set<string>();
const stores = new Set<WorkspaceStore>();

afterEach(async () => {
  const openStores = [...stores];
  stores.clear();
  await Promise.all(openStores.map((store) => store.close()));

  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
  directories.clear();
});

let socketCounter = 0;
let deltaCounter = 0;

export function makeStore(): WorkspaceStore {
  const directory = mkdtempSync(join(tmpdir(), "chorus-hub-"));
  directories.add(directory);
  const store = new WorkspaceStore(directory);
  stores.add(store);
  return store;
}

export function makeSocket(buffered = 0): FakeSocket {
  let socket: FakeSocket;
  socket = {
    buffered,
    closeCalls: [],
    getBufferedAmount: () => socket.buffered,
    id: `sock-${socketCounter++}`,
    messages: [],
    sent: [],
    send(data) {
      socket.sent.push(data);
      socket.messages.push(JSON.parse(data) as Record<string, unknown>);
      return data.length;
    },
    close(code, reason) {
      socket.closeCalls.push({ code, reason });
    },
  };
  return socket;
}

export async function connect(
  hub: WorkspaceHub,
  socket: FakeSocket,
  since = 0
): Promise<void> {
  hub.register(socket);
  await hub.handleRawMessage(
    socket,
    JSON.stringify({ since, type: "hello", workspaceId: hub.workspaceId })
  );
}

export async function seedBoard(
  store: WorkspaceStore,
  title = "Repo"
): Promise<string> {
  const commit = await store.applyMutation({
    baseRevision: null,
    clientId: "hub-test",
    mutationId: `seed-${crypto.randomUUID()}`,
    payload: {
      seed: {
        repo: { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" },
        title,
      },
    },
    type: "board.create",
  });
  const event = commit?.events[0];
  if (!commit || event?.type !== "board.created") {
    throw new Error("expected board.created");
  }
  return event.board.boardId;
}

export async function seedSession(store: WorkspaceStore): Promise<string> {
  const commit = await store.applyMutation({
    baseRevision: null,
    clientId: "repro",
    mutationId: "seed",
    payload: {
      seed: {
        repo: { directory: "/tmp/r", sandboxes: [], worktree: "/tmp/r" },
        title: "Repro",
      },
    },
    type: "board.create",
  });
  const event = commit?.events[0];
  if (!commit || event?.type !== "board.created") {
    throw new Error("expected board.created");
  }
  const boardId = event.board.boardId;

  await store.applyBoardEvents(boardId, [
    {
      boardId,
      column: "in_progress",
      task: {
        id: "task-1",
        label: "repo",
        labelVariant: "primary-light",
        title: "T",
      },
      taskId: "task-1",
      ts: Date.now(),
      type: "card.created",
    },
  ]);
  await store.applyMutation({
    baseRevision: null,
    clientId: "repro",
    mutationId: "sess",
    payload: {
      boardId,
      session: {
        currentTaskId: "task-1",
        sessionId: "sess-1",
        state: "active",
      },
    },
    type: "board.session.patch",
  });
  return boardId;
}

export async function emitDelta(
  store: WorkspaceStore,
  content: string
): Promise<void> {
  deltaCounter += 1;
  await store.applyAgentEvent({
    delta: content,
    partID: "p1",
    sessionID: "sess-1",
    timestamp: deltaCounter,
    type: "message.part.updated",
  });
}
