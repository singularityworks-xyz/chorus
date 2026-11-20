import { afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBoard } from "@chorus/contracts";
import type { Session } from "@chorus/oc-adapter";
import { WorkspaceStore } from "../workspace/store";
import type { BoardTaskService } from "./board-task-service";
import type { BoardTaskBridge } from "./bridge";

const directories = new Set<string>();
const stores = new Set<WorkspaceStore>();
const storeDirectories = new WeakMap<WorkspaceStore, string>();

afterEach(async () => {
  const openStores = [...stores];
  stores.clear();
  await Promise.all(openStores.map((store) => store.close()));

  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
  directories.clear();
});

export function makeWorkspaceStore(prefix = "chorus-task-"): WorkspaceStore {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.add(directory);
  const store = new WorkspaceStore(directory);
  stores.add(store);
  storeDirectories.set(store, directory);
  return store;
}

export async function reopenWorkspaceStore(
  store: WorkspaceStore
): Promise<WorkspaceStore> {
  const directory = storeDirectories.get(store);
  if (!directory) {
    throw new Error("workspace store was not created by task test support");
  }

  stores.delete(store);
  await store.close();
  const reopened = new WorkspaceStore(directory);
  stores.add(reopened);
  storeDirectories.set(reopened, directory);
  return reopened;
}

export function makeMockBridge() {
  const session: Pick<Session, "directory" | "id"> &
    Partial<Pick<Session, "revert">> = {
    directory: "/tmp/repo",
    id: "sess-123",
  };
  return {
    abortSession: mock(async () => true),
    createSession: mock(async () => ({ id: "sess-123" })),
    forkSession: mock(async () => ({ id: "sess-forked" })),
    getSession: mock(async () => session),
    promptSession: mock(async () => undefined),
    promptSessionAsync: mock(async () => undefined),
    revertSession: mock(async () => ({ messageID: "message-1" })),
    sessionMessages: mock(async () => [{ info: { role: "user" as const } }]),
    subscribeDirectory: mock(async () => undefined),
    unrevertSession: mock(async () => undefined),
    waitForSessionIdle: mock(
      async (_sessionId: string, _directory: string, timeoutMs: number) =>
        timeoutMs > 0
    ),
  } satisfies BoardTaskBridge;
}

export const REPO = {
  directory: "/tmp/repo",
  sandboxes: [],
  worktree: "/tmp/repo",
};

export async function seedBoard(
  workspaceStore: WorkspaceStore,
  session?: Partial<WorkspaceBoard["session"]>,
  repo: { directory: string; worktree: string } = REPO,
  configureGlobalModel = true
): Promise<string> {
  const created = await workspaceStore.applyMutation({
    baseRevision: null,
    clientId: "task-test",
    mutationId: `seed-${crypto.randomUUID()}`,
    payload: {
      seed: { repo: { ...repo, sandboxes: [] }, title: "Repo Board" },
    },
    type: "board.create",
  });

  const event = created?.events[0];
  if (!created || event?.type !== "board.created") {
    throw new Error("expected a board.created commit");
  }

  const boardId = event.board.boardId;

  if (configureGlobalModel) {
    await workspaceStore.applyMutation({
      baseRevision: null,
      clientId: "task-test",
      mutationId: `default-model-${crypto.randomUUID()}`,
      payload: { model: { providerID: "anthropic", modelID: "claude" } },
      type: "preference.default_model.set",
    });
  }

  if (session) {
    await workspaceStore.applyMutation({
      baseRevision: null,
      clientId: "task-test",
      mutationId: `session-${crypto.randomUUID()}`,
      payload: { boardId, session },
      type: "board.session.patch",
    });
  }

  return boardId;
}

export async function addSavedTask(
  store: WorkspaceStore,
  boardId: string,
  taskId: string,
  text = "saved prompt"
): Promise<void> {
  await store.applyBoardEvents(boardId, [
    {
      boardId,
      column: "queue",
      task: {
        id: taskId,
        label: text,
        labelVariant: "info-light",
        promptInput: { reviewMode: "auto", text },
        title: text,
      },
      taskId,
      ts: Date.now(),
      type: "card.created",
    },
  ]);
}

export async function createManualReviewTask(
  service: BoardTaskService,
  store: WorkspaceStore,
  boardId: string
) {
  const queued = await service.queuePrompt({
    boardId,
    directory: "/tmp/repo",
    text: "Implement the requested feature",
    reviewMode: "manual",
  });
  const timestamp = Date.now();
  await store.applyBoardEvents(boardId, [
    {
      boardId,
      model: "anthropic/claude",
      sessionId: queued.sessionId,
      startedAt: timestamp,
      taskId: queued.taskId,
      taskTitle: "Implement the requested feature",
      ts: timestamp,
      type: "run.started",
    },
    {
      boardId,
      ts: timestamp + 1,
      type: "session.idle",
    },
  ]);
  return queued;
}

export async function createRunningTask(
  service: BoardTaskService,
  store: WorkspaceStore,
  boardId: string
) {
  const queued = await service.queuePrompt({
    boardId,
    directory: "/tmp/repo",
    text: "Implement the requested feature",
    reviewMode: "auto",
  });
  await store.applyBoardEvents(boardId, [
    {
      boardId,
      taskId: queued.taskId,
      ts: Date.now(),
      type: "card.started",
    },
    {
      boardId,
      model: "anthropic/claude",
      sessionId: queued.sessionId,
      startedAt: Date.now(),
      taskId: queued.taskId,
      taskTitle: "Implement the requested feature",
      ts: Date.now(),
      type: "run.started",
    },
  ]);
  return queued;
}

export const NO_SUCH_BOARD = /no such board/;
export const BOARD_IS_CLOSING = /board is closing/;
