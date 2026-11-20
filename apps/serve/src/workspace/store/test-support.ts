import { afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceMutation } from "@chorus/contracts";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { WorkspaceStore } from "../store";

type StoreOptions = ConstructorParameters<typeof WorkspaceStore>[1];

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

export function createTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.add(directory);
  return directory;
}

export function createStore(options?: StoreOptions): WorkspaceStore {
  return createStoreAt(createTempDir("chorus-store-"), options);
}

export function createStoreAt(
  directory: string,
  options?: StoreOptions
): WorkspaceStore {
  directories.add(directory);
  const store = new WorkspaceStore(directory, options);
  stores.add(store);
  return store;
}

export function fileMode(path: string): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: mode is a bitfield
  return statSync(path).mode & 0o777;
}

let mutationCounter = 0;

export function mutation<T extends WorkspaceMutation["type"]>(
  type: T,
  payload: Extract<WorkspaceMutation, { type: T }>["payload"]
): Extract<WorkspaceMutation, { type: T }> {
  mutationCounter += 1;
  return {
    baseRevision: null,
    clientId: "test-client",
    mutationId: `mut-${mutationCounter}`,
    payload,
    type,
  } as Extract<WorkspaceMutation, { type: T }>;
}

export const SEED = {
  repo: { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" },
  title: "Repo",
};

export async function seedBoard(
  store: WorkspaceStore,
  title = "Repo"
): Promise<string> {
  const commit = await store.applyMutation(
    mutation("board.create", { seed: { ...SEED, title } })
  );

  const event = commit?.events[0];
  if (!commit || event?.type !== "board.created") {
    throw new Error("expected a board.created commit");
  }

  return event.board.boardId;
}

export async function seedActiveBoard(store: WorkspaceStore): Promise<string> {
  const boardId = await seedBoard(store);

  await store.applyBoardEvents(boardId, [
    {
      boardId,
      column: "in_progress",
      task: {
        id: "task-1",
        label: "repo",
        labelVariant: "primary-light",
        title: "Do the thing",
      },
      taskId: "task-1",
      ts: Date.now(),
      type: "card.created",
    },
  ]);

  await store.applyMutation(
    mutation("board.session.patch", {
      boardId,
      session: {
        currentTaskId: "task-1",
        sessionId: "sess-1",
        state: "active",
      },
    })
  );

  return boardId;
}

export function agentEvent(
  overrides: Partial<NormalizedAgentEvent>
): NormalizedAgentEvent {
  return {
    sessionID: "sess-1",
    timestamp: Date.now(),
    type: "message.part.updated",
    ...overrides,
  };
}
