import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRegisteredRoot,
  isRegisteredRoot,
  repoRoots,
  UnregisteredRootError,
} from "./roots";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "chorus-roots-"));
}

describe("registered repository roots (spec §6.4, plan P4.6)", () => {
  test("a board contributes its directory and worktree", () => {
    expect(
      repoRoots({
        repo: {
          directory: "/repos/a",
          worktree: "/repos/a/.chorus-worktrees/b1",
        },
      })
    ).toEqual(["/repos/a", "/repos/a/.chorus-worktrees/b1"]);
  });

  test("projectId is not treated as a filesystem root", () => {
    // It is an opencode project identifier; treating it as a path would grant
    // authority to a string that never named one.
    expect(
      repoRoots({ repo: { directory: "/repos/a", projectId: "my-project" } })
    ).toEqual(["/repos/a"]);
  });

  test("a board with no repo contributes nothing", () => {
    expect(repoRoots({})).toEqual([]);
    expect(repoRoots({ repo: null })).toEqual([]);
    expect(repoRoots({ repo: {} })).toEqual([]);
  });

  test("a registered directory is accepted", () => {
    const boards = [{ repo: { directory: "/repos/a", worktree: null } }];

    expect(assertRegisteredRoot("/repos/a", boards)).toBe("/repos/a");
    expect(isRegisteredRoot("/repos/a", boards)).toBe(true);
  });

  test("an unregistered absolute path is rejected", () => {
    const boards = [{ repo: { directory: "/repos/a" } }];

    expect(() => assertRegisteredRoot("/etc", boards)).toThrow(
      UnregisteredRootError
    );
    expect(isRegisteredRoot("/etc", boards)).toBe(false);
  });

  test("a worktree is accepted alongside its primary checkout", () => {
    const boards = [
      {
        repo: {
          directory: "/repos/a",
          worktree: "/repos/a/.chorus-worktrees/board-1",
        },
      },
    ];

    expect(isRegisteredRoot("/repos/a/.chorus-worktrees/board-1", boards)).toBe(
      true
    );
  });

  test("containment is not authority: a subdirectory is rejected", () => {
    // These routes operate on a whole repository, so "somewhere inside a
    // registered repo" is not sufficient authority to run git against it.
    const boards = [{ repo: { directory: "/repos/a" } }];

    expect(isRegisteredRoot("/repos/a/sub", boards)).toBe(false);
  });

  test("no boards means nothing is registered", () => {
    expect(isRegisteredRoot("/repos/a", [])).toBe(false);
  });

  test("a symlink inside a registered root cannot widen it", () => {
    const root = tempDir();
    const outside = tempDir();

    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(root, "escape"));

      // Lexical containment passes this: the path is under the root and uses no
      // `..`. Only realpath resolution catches it.
      const boards = [{ repo: { directory: root } }];
      expect(isRegisteredRoot(join(root, "escape"), boards)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("a real path is matched after symlink resolution on both sides", () => {
    const real = tempDir();
    const alias = tempDir();

    try {
      mkdirSync(join(alias, "link"), { recursive: true });
      symlinkSync(real, join(alias, "link", "repo"));

      // The board registered the alias; the request named the real path. Both
      // canonicalise to the same directory, so it is the same repository.
      const boards = [{ repo: { directory: join(alias, "link", "repo") } }];

      expect(isRegisteredRoot(real, boards)).toBe(true);
    } finally {
      rmSync(real, { force: true, recursive: true });
      rmSync(alias, { force: true, recursive: true });
    }
  });

  test("a path that does not exist yet still resolves for a future worktree", () => {
    const boards = [
      { repo: { worktree: "/repos/a/.chorus-worktrees/board-not-created" } },
    ];

    expect(
      isRegisteredRoot("/repos/a/.chorus-worktrees/board-not-created", boards)
    ).toBe(true);
  });

  test("traversal out of a registered root is rejected", () => {
    const boards = [{ repo: { directory: "/repos/a" } }];

    expect(isRegisteredRoot("/repos/a/../b", boards)).toBe(false);
    expect(isRegisteredRoot("/repos/a/../../etc", boards)).toBe(false);
  });
});
