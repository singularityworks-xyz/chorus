import { describe, expect, test } from "bun:test";
import { BoardTaskService } from "../board-task-service";
import { SessionOwnershipError } from "../errors";
import { makeMockBridge, makeWorkspaceStore, seedBoard } from "../test-support";

describe("BoardTaskService", () => {
  describe("session reuse is scoped to a directory (plan P6 task 3)", () => {
    test("same directory reuses the session", async () => {
      const bridge = makeMockBridge();
      const workspaceStore = makeWorkspaceStore("chorus-reuse-same-");
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge, workspaceStore);

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "keep going",
        reviewMode: "auto",
      });

      expect(result.sessionId).toBe("sess-123");
      expect(result.createdSession).toBe(false);
      expect(bridge.forkSession).not.toHaveBeenCalled();
    });

    test("a persisted session the engine places elsewhere forks", async () => {
      const bridge = makeMockBridge();
      bridge.getSession.mockResolvedValue({
        directory: "/tmp/repo/.chorus-worktrees/some-other-board",
        id: "sess-123",
      });
      const workspaceStore = makeWorkspaceStore("chorus-reuse-elsewhere-");
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge, workspaceStore);

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
    });

    test("a persisted session the engine confirms in place is reused", async () => {
      const bridge = makeMockBridge();
      const workspaceStore = makeWorkspaceStore("chorus-reuse-confirmed-");
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge, workspaceStore);

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
    });

    test("an engine lookup failure refuses unverified session reuse", async () => {
      const bridge = makeMockBridge();
      bridge.getSession.mockRejectedValue(new Error("engine unreachable"));
      const workspaceStore = makeWorkspaceStore("chorus-reuse-unreachable-");
      await workspaceStore.load();
      const boardId = await seedBoard(
        workspaceStore,
        { sessionId: "sess-123", state: "active" },
        { directory: "/tmp/repo", worktree: "/tmp/repo" }
      );
      const service = new BoardTaskService(bridge, workspaceStore);

      await expect(
        service.queuePrompt({
          boardId,
          directory: "/tmp/repo",
          text: "carry on",
          reviewMode: "auto",
        })
      ).rejects.toBeInstanceOf(SessionOwnershipError);

      expect(bridge.forkSession).not.toHaveBeenCalled();
      expect(bridge.promptSessionAsync).not.toHaveBeenCalled();
    });

    test("a trailing separator on the stored path is not a different directory", async () => {
      const bridge = makeMockBridge();
      const workspaceStore = makeWorkspaceStore("chorus-reuse-slash-");
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge, workspaceStore);

      await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "first",
        reviewMode: "auto",
      });
      const currentTaskId =
        workspaceStore.getBoard(boardId)?.session.currentTaskId;
      if (currentTaskId) {
        await workspaceStore.applyBoardEvents(boardId, [
          {
            boardId,
            taskId: currentTaskId,
            ts: Date.now(),
            type: "card.completed",
          },
        ]);
      }

      bridge.getSession.mockResolvedValue({
        directory: "/tmp/repo/",
        id: "sess-123",
      });

      const result = await service.queuePrompt({
        boardId,
        directory: "/tmp/repo",
        text: "same tree, different spelling",
        reviewMode: "auto",
      });

      expect(bridge.forkSession).not.toHaveBeenCalled();
      expect(result.sessionId).toBe("sess-123");
    });

    test("a client cannot redirect the agent to a directory it names", async () => {
      const bridge = makeMockBridge();
      const workspaceStore = makeWorkspaceStore("chorus-reuse-override-");
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge, workspaceStore);

      await service.queuePrompt({
        boardId,
        directory: "/somewhere/else",
        text: "not that way",
        reviewMode: "auto",
      });

      expect(bridge.subscribeDirectory).toHaveBeenCalledWith("/tmp/repo");
      expect(bridge.forkSession).not.toHaveBeenCalled();
    });

    test("a client cannot bind an unrelated session to the board", async () => {
      const bridge = makeMockBridge();
      const workspaceStore = makeWorkspaceStore("chorus-session-ownership-");
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        sessionId: "sess-123",
        state: "active",
      });
      const service = new BoardTaskService(bridge, workspaceStore);

      await expect(
        service.queuePrompt({
          boardId,
          directory: "/tmp/repo",
          sessionId: "sess-unrelated",
          text: "do not steal another session",
          reviewMode: "auto",
        })
      ).rejects.toMatchObject({ code: "session_ownership_conflict" });
      expect(bridge.getSession).not.toHaveBeenCalled();
      expect(bridge.promptSessionAsync).not.toHaveBeenCalled();
    });
  });
});
