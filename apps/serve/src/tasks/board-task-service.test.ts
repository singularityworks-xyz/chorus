import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBoard } from "@chorus/contracts";
import { WorkspaceStore } from "../workspace/store";
import { BoardTaskService } from "./board-task-service";

function makeMockBridge() {
  return {
    createSession: mock(async () => ({ id: "sess-123" })),
    promptSession: mock(async () => undefined),
    promptSessionAsync: mock(async () => undefined),
    subscribeDirectory: mock(async () => undefined),
  };
}

const REPO = { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" };

/**
 * Board ids are server-generated (the client sends a seed and the store mints
 * the board), so fixtures read the id back off the commit instead of assuming
 * one. An earlier version of this file hard-coded "board-1" and the
 * session patch silently no-oped against a board that did not exist.
 */
async function seedBoard(
  workspaceStore: WorkspaceStore,
  session?: Partial<WorkspaceBoard["session"]>
) {
  const created = await workspaceStore.applyMutation({
    baseRevision: null,
    clientId: "task-test",
    mutationId: `seed-${crypto.randomUUID()}`,
    payload: { seed: { repo: REPO, title: "Repo Board" } },
    type: "board.create",
  });

  const event = created?.events[0];
  if (!created || event?.type !== "board.created") {
    throw new Error("expected a board.created commit");
  }

  const boardId = event.board.boardId;

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

describe("BoardTaskService", () => {
  test("creates a session for the first prompt", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-create-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);

    const result = await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "build feature",
      reviewMode: "auto",
    });

    expect(result.boardId).toBe(boardId);
    expect(result.sessionId).toBe("sess-123");
    expect(result.createdSession).toBe(true);
    expect(bridge.createSession).toHaveBeenCalledWith({
      title: "build feature",
      directory: "/tmp/repo",
    });
    expect(bridge.promptSessionAsync).toHaveBeenCalledWith({
      sessionID: "sess-123",
      directory: "/tmp/repo",
      text: "build feature",
      model: undefined,
      agent: undefined,
    });

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("reuses the persisted session for later prompts", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-reuse-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "active",
    });

    const service = new BoardTaskService(bridge as never, workspaceStore);

    const result = await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "follow up",
      reviewMode: "auto",
    });

    expect(result.createdSession).toBe(false);
    expect(bridge.createSession).toHaveBeenCalledTimes(0);
    expect(bridge.promptSessionAsync).toHaveBeenLastCalledWith({
      sessionID: "sess-123",
      directory: "/tmp/repo",
      text: "follow up",
      model: undefined,
      agent: undefined,
    });

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("binds the created session onto the board in the event log", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-bind-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);
    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "build feature",
      reviewMode: "auto",
    });

    // The session binding has to be durable, not just in-memory: a restart
    // mid-session must find it again.
    expect(workspaceStore.getBoard(boardId)?.session.sessionId).toBe(
      "sess-123"
    );
    await workspaceStore.close();

    const reopened = new WorkspaceStore(dir);
    await reopened.load();
    expect(reopened.getBoard(boardId)?.session.sessionId).toBe("sess-123");
    await reopened.close();

    rmSync(dir, { force: true, recursive: true });
  });
  test("queueing a prompt creates the card that agent events attach to", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-card-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);
    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "build the feature",
      reviewMode: "auto",
    });

    const board = workspaceStore.getBoard(boardId);
    const card = board?.columns.queue?.[0];

    expect(card).toBeDefined();
    expect(card?.title).toBe("build the feature");
    // The load-bearing part: without this the store has no task id to attach
    // agent events to, and every task-scoped event is dropped.
    expect(board?.session.currentTaskId).toBe(card?.id);

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("a second prompt on a live board reuses the card instead of stacking one", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-card2-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, { state: "uninitialized" });

    const service = new BoardTaskService(bridge as never, workspaceStore);
    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "first prompt",
      reviewMode: "auto",
    });
    const firstTaskId = workspaceStore.getBoard(boardId)?.session.currentTaskId;

    await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "second prompt",
      reviewMode: "auto",
    });

    const board = workspaceStore.getBoard(boardId);
    expect(board?.columns.queue).toHaveLength(1);
    expect(board?.session.currentTaskId).toBe(firstTaskId);

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("a card is created even when the session was reused", async () => {
    const bridge = makeMockBridge();
    const dir = mkdtempSync(join(tmpdir(), "chorus-board-task-card3-"));
    const workspaceStore = new WorkspaceStore(dir);
    await workspaceStore.load();
    const boardId = await seedBoard(workspaceStore, {
      sessionId: "sess-123",
      state: "uninitialized",
    });

    const service = new BoardTaskService(bridge as never, workspaceStore);
    const result = await service.queuePrompt({
      boardId,
      directory: "/tmp/repo",
      text: "continue the work",
      reviewMode: "auto",
    });

    expect(result.createdSession).toBe(false);
    expect(workspaceStore.getBoard(boardId)?.columns.queue).toHaveLength(1);
    expect(
      workspaceStore.getBoard(boardId)?.session.currentTaskId
    ).toBeDefined();

    await workspaceStore.close();
    rmSync(dir, { force: true, recursive: true });
  });
});
