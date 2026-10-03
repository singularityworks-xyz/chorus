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
    forkSession: mock(async () => ({ id: "sess-forked" })),
    getSession: mock(async () => ({ directory: "/tmp/repo", id: "sess-123" })),
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
  session?: Partial<WorkspaceBoard["session"]>,
  repo: { directory: string; worktree: string } = REPO
) {
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
  describe("session reuse is scoped to a directory (plan P6 task 3)", () => {
    /**
     * A session belongs to the tree it was opened in.
     *
     * The trigger is the *board's* directory changing — it gets reprovisioned onto
     * a new worktree — not the client asking for a different one. The service
     * resolves the working directory itself now, so a client cannot aim a prompt
     * anywhere; the registry's recorded directory is compared against the board's
     * current one.
     */
    test("same directory reuses the session", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-same-"));
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
        text: "keep going",
        reviewMode: "auto",
      });

      expect(result.sessionId).toBe("sess-123");
      expect(result.createdSession).toBe(false);
      expect(bridge.forkSession).not.toHaveBeenCalled();

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a persisted session the engine places elsewhere forks", async () => {
      // The realistic shape: serve restarted, so the registry is empty, and the
      // stored session id turns out to belong to a different board's checkout.
      // Only the engine can answer that, so it is asked.
      const bridge = makeMockBridge();
      bridge.getSession.mockResolvedValue({
        directory: "/tmp/repo/.chorus-worktrees/some-other-board",
        id: "sess-123",
      } as never);
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-elsewhere-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge as never, workspaceStore);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "carry on",
        reviewMode: "auto",
      });

      expect(bridge.forkSession).toHaveBeenCalledWith({
        directory: "/tmp/repo",
        sessionID: "sess-123",
      });
      expect(result.sessionId).toBe("sess-forked");

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a persisted session the engine confirms in place is reused", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-confirmed-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge as never, workspaceStore);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "carry on",
        reviewMode: "auto",
      });

      expect(bridge.getSession).toHaveBeenCalled();
      expect(bridge.forkSession).not.toHaveBeenCalled();
      expect(result.sessionId).toBe("sess-123");
      expect(result.createdSession).toBe(false);

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("an engine lookup failure reuses rather than forking", async () => {
      // Forking on a transient error would strand a session that was fine; the
      // cost of being wrong here is one extra session, not lost work.
      const bridge = makeMockBridge();
      bridge.getSession.mockRejectedValue(new Error("engine unreachable"));
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-unreachable-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge as never, workspaceStore);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "carry on",
        reviewMode: "auto",
      });

      expect(bridge.forkSession).not.toHaveBeenCalled();
      expect(result.sessionId).toBe("sess-123");

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a trailing separator on the stored path is not a different directory", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-slash-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge as never, workspaceStore);

      await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "first",
        reviewMode: "auto",
      });
      // The registry recorded `/tmp/repo`; the board now resolves through a
      // trailing separator. Same tree, so no fork.
      bridge.getSession.mockResolvedValue({
        directory: "/tmp/repo/",
        id: "sess-123",
      } as never);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "same tree, different spelling",
        reviewMode: "auto",
      });

      expect(bridge.forkSession).not.toHaveBeenCalled();
      expect(result.sessionId).toBe("sess-123");

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a client cannot redirect the agent to a directory it names", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-reuse-override-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge as never, workspaceStore);

      await service.queuePrompt({
        boardId,
        directory: "/somewhere/else",
        text: "not that way",
        reviewMode: "auto",
      });

      // The board's own checkout wins over whatever the caller asked for.
      expect(bridge.subscribeDirectory).toHaveBeenCalledWith("/tmp/repo");
      expect(bridge.forkSession).not.toHaveBeenCalled();

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });
  });

  describe("the agent runs in the board's own worktree", () => {
    /**
     * Regression: worktrees were created and recorded on the board but never used.
     * The client sends `repo.directory` with every prompt and the service passed it
     * straight through, so every agent ran in the primary checkout and two boards
     * on one repo shared an index — the exact collision worktree-per-board exists
     * to prevent. The service resolves the directory itself now.
     */
    test("a board with a worktree runs there, not in the primary checkout", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-worktree-bind-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      // What the store produces for the second board on a repo.
      const worktree = "/repos/app/.chorus-worktrees/board-7";
      const boardId = await seedBoard(
        workspaceStore,
        { state: "uninitialized" },
        { directory: "/repos/app", worktree }
      );

      const service = new BoardTaskService(bridge as never, workspaceStore);
      await service.queuePrompt({
        boardId,
        // What the client sends: the primary checkout.
        directory: "/repos/app",
        text: "do the work",
        reviewMode: "auto",
      });

      expect(bridge.subscribeDirectory).toHaveBeenCalledWith(worktree);
      expect(bridge.createSession).toHaveBeenCalledWith({
        directory: worktree,
        title: "do the work",
      });
      expect(bridge.promptSessionAsync).toHaveBeenCalledWith(
        expect.objectContaining({ directory: worktree })
      );

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });

    test("a board with no worktree keeps the primary checkout", async () => {
      const bridge = makeMockBridge();
      const dir = mkdtempSync(join(tmpdir(), "chorus-worktree-none-"));
      const workspaceStore = new WorkspaceStore(dir);
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        state: "uninitialized",
      });

      const service = new BoardTaskService(bridge as never, workspaceStore);
      await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "do the work",
        reviewMode: "auto",
      });

      expect(bridge.createSession).toHaveBeenCalledWith({
        directory: "/tmp/repo",
        title: "do the work",
      });

      await workspaceStore.close();
      rmSync(dir, { force: true, recursive: true });
    });
  });
});
