import { describe, expect, test } from "bun:test";
import { ReferenceLookupError } from "@chorus/oc-adapter";
import { BOARD_WORKTREE, makeApp } from "../test-support";

describe("GET /boards/:boardID/autocomplete", () => {
  test("uses the selected board worktree for normalized suggestions", async () => {
    const { app, bridge, boardTasks } = makeApp();
    const response = await app.handle(
      new Request(
        "http://localhost/boards/board-1/autocomplete?kind=files&query=main"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "files",
      files: ["src/main.ts"],
    });
    expect(boardTasks.assertBoardOpen).toHaveBeenCalledWith("board-1");
    expect(boardTasks.assertCheckoutAuthorized).toHaveBeenCalledWith(
      BOARD_WORKTREE
    );
    expect(bridge.findAutocompleteFiles).toHaveBeenCalledWith(
      "main",
      BOARD_WORKTREE
    );
  });

  test("serves commands, skills, and directory entries from the board checkout", async () => {
    const { app, bridge } = makeApp();
    const commandsResponse = await app.handle(
      new Request("http://localhost/boards/board-1/autocomplete?kind=commands")
    );
    const skillsResponse = await app.handle(
      new Request("http://localhost/boards/board-1/autocomplete?kind=skills")
    );
    const directoryResponse = await app.handle(
      new Request(
        "http://localhost/boards/board-1/autocomplete?kind=directory&path=%2Fsrc"
      )
    );

    expect(commandsResponse.status).toBe(200);
    expect(await commandsResponse.json()).toEqual({
      kind: "commands",
      commands: [{ name: "review", description: "Review changes" }],
    });
    expect(skillsResponse.status).toBe(200);
    expect(await skillsResponse.json()).toEqual({
      kind: "skills",
      skills: [{ name: "typescript", description: "TypeScript" }],
    });
    expect(directoryResponse.status).toBe(200);
    expect(await directoryResponse.json()).toEqual({
      kind: "directory",
      entries: [{ path: "src/test", type: "directory" }],
    });
    expect(bridge.listAutocompleteCommands).toHaveBeenCalledWith(
      BOARD_WORKTREE
    );
    expect(bridge.listAutocompleteSkills).toHaveBeenCalledWith(BOARD_WORKTREE);
    expect(bridge.listAutocompleteDirectory).toHaveBeenCalledWith(
      "src",
      BOARD_WORKTREE
    );
  });

  test("rejects unknown boards, invalid lookups, and paths outside the board", async () => {
    const { app, bridge } = makeApp();
    const unknownBoard = await app.handle(
      new Request("http://localhost/boards/missing/autocomplete?kind=commands")
    );
    const invalidKind = await app.handle(
      new Request("http://localhost/boards/board-1/autocomplete?kind=other")
    );
    const escapingPath = await app.handle(
      new Request(
        "http://localhost/boards/board-1/autocomplete?kind=directory&path=..%2Fsecret"
      )
    );
    const rootedWindowsPath = await app.handle(
      new Request(
        "http://localhost/boards/board-1/autocomplete?kind=directory&path=%5Csecret"
      )
    );

    expect(unknownBoard.status).toBe(404);
    expect(invalidKind.status).toBe(422);
    expect(escapingPath.status).toBe(422);
    expect(rootedWindowsPath.status).toBe(422);
    expect(bridge.listAutocompleteDirectory).not.toHaveBeenCalled();
  });

  test("maps provider failures to a retryable client error", async () => {
    const { app, bridge } = makeApp();
    bridge.listAutocompleteCommands.mockRejectedValue(
      new ReferenceLookupError("OpenCode command.list failed: disconnected")
    );

    const response = await app.handle(
      new Request("http://localhost/boards/board-1/autocomplete?kind=commands")
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      code: "autocomplete_unavailable",
      message:
        "Could not load board suggestions. Check the provider connection and retry.",
    });
  });
});
