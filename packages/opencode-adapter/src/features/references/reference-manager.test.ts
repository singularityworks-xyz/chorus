import { describe, expect, mock, test } from "bun:test";
import {
  ReferenceLookupError,
  WorkspaceReferenceManager,
} from "./reference-manager";

describe("WorkspaceReferenceManager", () => {
  test("normalizes command, skill, file, and directory results for a checkout", async () => {
    const commandList = mock(async () => ({
      data: {
        location: { directory: "/repo/board" },
        data: [
          { name: "review", template: "review", description: "Review changes" },
        ],
      },
    }));
    const skillList = mock(async () => ({
      data: {
        location: { directory: "/repo/board" },
        data: [
          {
            name: "typescript",
            location: "/skills/typescript",
            content: "",
            description: "TypeScript",
          },
        ],
      },
    }));
    const fileFind = mock(async () => ({
      data: {
        location: { directory: "/repo/board" },
        data: [{ path: "src/main.ts", type: "file" as const }],
      },
    }));
    const directoryList = mock(async () => ({
      data: {
        location: { directory: "/repo/board" },
        data: [{ path: "src/test", type: "directory" as const }],
      },
    }));
    const manager = new WorkspaceReferenceManager({
      v2: {
        command: { list: commandList },
        skill: { list: skillList },
        fs: { find: fileFind, list: directoryList },
      },
    } as never);

    await expect(manager.listCommands("/repo/board")).resolves.toEqual([
      { name: "review", description: "Review changes" },
    ]);
    await expect(manager.listSkills("/repo/board")).resolves.toEqual([
      { name: "typescript", description: "TypeScript" },
    ]);
    await expect(manager.findFiles("main", "/repo/board")).resolves.toEqual([
      { path: "src/main.ts", type: "file" },
    ]);
    await expect(manager.listDirectory("src", "/repo/board")).resolves.toEqual([
      { path: "src/test", type: "directory" },
    ]);

    expect(commandList).toHaveBeenCalledWith({
      location: { directory: "/repo/board" },
    });
    expect(skillList).toHaveBeenCalledWith({
      location: { directory: "/repo/board" },
    });
    expect(fileFind).toHaveBeenCalledWith({
      location: { directory: "/repo/board" },
      query: "main",
      type: "file",
      limit: "50",
    });
    expect(directoryList).toHaveBeenCalledWith({
      location: { directory: "/repo/board" },
      path: "src",
    });
  });

  test("turns an SDK error response into a useful adapter failure", async () => {
    const manager = new WorkspaceReferenceManager({
      v2: {
        command: {
          list: mock(async () => ({
            error: { message: "engine disconnected" },
          })),
        },
      },
    } as never);

    await expect(manager.listCommands("/repo/board")).rejects.toBeInstanceOf(
      ReferenceLookupError
    );
    await expect(manager.listCommands("/repo/board")).rejects.toThrow(
      "OpenCode command.list failed: engine disconnected"
    );
  });

  test("normalizes SDK transport rejections", async () => {
    const manager = new WorkspaceReferenceManager({
      v2: {
        command: {
          list: mock(() => Promise.reject(new Error("connection refused"))),
        },
      },
    } as never);

    await expect(manager.listCommands("/repo/board")).rejects.toBeInstanceOf(
      ReferenceLookupError
    );
    await expect(manager.listCommands("/repo/board")).rejects.toThrow(
      "OpenCode command.list failed: connection refused"
    );
  });
});
