import { describe, expect, test } from "bun:test";
import { BoardTaskService } from "../board-task-service";
import { makeMockBridge, makeWorkspaceStore, seedBoard } from "../test-support";

describe("BoardTaskService", () => {
  describe("the agent runs in the board's own worktree", () => {
    test("a board with a worktree runs there, not in the primary checkout", async () => {
      const bridge = makeMockBridge();
      const workspaceStore = makeWorkspaceStore("chorus-worktree-bind-");
      await workspaceStore.load();

      const worktree = "/repos/app/.chorus-worktrees/board-7";
      const boardId = await seedBoard(
        workspaceStore,
        { state: "uninitialized" },
        { directory: "/repos/app", worktree }
      );

      const service = new BoardTaskService(bridge, workspaceStore);
      await service.queuePrompt({
        boardId,

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
    });

    test("a board with no worktree keeps the primary checkout", async () => {
      const bridge = makeMockBridge();
      const workspaceStore = makeWorkspaceStore("chorus-worktree-none-");
      await workspaceStore.load();
      const boardId = await seedBoard(workspaceStore, {
        state: "uninitialized",
      });

      const service = new BoardTaskService(bridge, workspaceStore);
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
    });
  });
});
