import { describe, expect, test } from "bun:test";
import {
  portableGitRefSchema,
  portableRepositoryPathSchema,
  repositoryCheckpointSchema,
} from "./repository-transfer";

const content = { digest: "a".repeat(64), bytes: 0 };
const empty = {
  version: 1,
  objectFormat: "sha1",
  head: null,
  branch: "refs/heads/main",
  refs: [],
  history: null,
  staged: content,
  files: [],
};

describe("portable repository contracts", () => {
  test("rejects traversal, metadata aliases, device paths, controls and nonportable names", () => {
    for (const path of [
      "../escape",
      "a/../../b",
      "/absolute",
      "C:/drive",
      "a\\b",
      ".GIT/config",
      ".git~1/config",
      "git~1/hooks/pre-commit",
      ".git\u200c/config",
      ".chorus/host",
      ".chorus-worktrees/board/file",
      "CON.txt",
      "LPT1",
      "COM¹.txt",
      "a\0b",
      "folder/file.",
      "folder/space ",
      "a//b",
    ]) {
      expect(portableRepositoryPathSchema.safeParse(path).success).toBe(false);
    }
    expect(portableRepositoryPathSchema.parse("src/hello world.ts")).toBe(
      "src/hello world.ts"
    );
    expect(portableRepositoryPathSchema.parse(".github/workflows/ci.yml")).toBe(
      ".github/workflows/ci.yml"
    );
  });

  test("rejects ambiguous paths, object formats, missing history and ref injection", () => {
    expect(repositoryCheckpointSchema.parse(empty).files).toEqual([]);
    const file = (path: string) => ({ path, mode: "100644", content });
    for (const files of [
      [file("README"), file("readme")],
      [file("a"), file("a/b")],
    ]) {
      expect(
        repositoryCheckpointSchema.safeParse({ ...empty, files }).success
      ).toBe(false);
    }
    expect(
      repositoryCheckpointSchema.safeParse({ ...empty, head: "a".repeat(40) })
        .success
    ).toBe(false);
    expect(
      repositoryCheckpointSchema.safeParse({
        ...empty,
        objectFormat: "sha256",
        refs: [{ name: "refs/heads/main", oid: "a".repeat(40) }],
        history: content,
      }).success
    ).toBe(false);
    for (const name of [
      "refs/heads/a\nupdate HEAD x",
      "refs/heads/../bad",
      "HEAD",
      "refs/stash",
      "refs/heads/a.lock",
      "refs/heads/a//b",
    ]) {
      expect(portableGitRefSchema.safeParse(name).success).toBe(false);
    }
  });
});
