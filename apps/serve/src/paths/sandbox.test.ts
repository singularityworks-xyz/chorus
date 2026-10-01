import { describe, expect, test } from "bun:test";
import {
  assertSafeGitRevision,
  InvalidPathError,
  isInside,
  resolveInside,
  SandboxEscapeError,
} from "./sandbox";

describe("resolveInside", () => {
  test("resolves a relative path under the root", () => {
    expect(resolveInside("/data/repo", "src/index.ts")).toBe(
      "/data/repo/src/index.ts"
    );
  });

  test("resolves a nested relative path that stays inside", () => {
    expect(resolveInside("/data/repo", "a/b/../c/file.txt")).toBe(
      "/data/repo/a/c/file.txt"
    );
  });

  test("returns the root itself for an empty relative segment", () => {
    expect(resolveInside("/data/repo", ".")).toBe("/data/repo");
  });

  test("accepts an absolute path already inside the root", () => {
    expect(resolveInside("/data/repo", "/data/repo/src")).toBe(
      "/data/repo/src"
    );
  });

  test("accepts the root as an absolute candidate", () => {
    expect(resolveInside("/data/repo", "/data/repo")).toBe("/data/repo");
  });

  test("rejects a relative traversal", () => {
    expect(() => resolveInside("/data/repo", "../secrets")).toThrow(
      SandboxEscapeError
    );
  });

  test("rejects a deep relative traversal", () => {
    expect(() => resolveInside("/data/repo", "src/../../etc/passwd")).toThrow(
      SandboxEscapeError
    );
  });

  test("rejects an absolute path outside the root", () => {
    expect(() => resolveInside("/data/repo", "/etc/passwd")).toThrow(
      SandboxEscapeError
    );
  });

  test("rejects a prefix-sibling path that only shares a name prefix", () => {
    expect(() => resolveInside("/data", "/data2/secret")).toThrow(
      SandboxEscapeError
    );
  });

  test("does not reject a child whose name merely starts with dots", () => {
    expect(resolveInside("/data/repo", "..foo")).toBe("/data/repo/..foo");
  });

  test("rejects an empty candidate", () => {
    expect(() => resolveInside("/data/repo", "")).toThrow(InvalidPathError);
  });

  test("rejects a NUL byte in the candidate", () => {
    expect(() => resolveInside("/data/repo", "src/\0evil")).toThrow(
      InvalidPathError
    );
  });

  test("rejects a NUL byte in an absolute candidate", () => {
    expect(() => resolveInside("/data/repo", "/data/repo/\0evil")).toThrow(
      InvalidPathError
    );
  });

  test("normalizes the root before comparing", () => {
    expect(resolveInside("/data/./repo", "src")).toBe("/data/repo/src");
  });
});

describe("isInside", () => {
  test("reports true for contained paths", () => {
    expect(isInside("/data/repo", "src/index.ts")).toBe(true);
  });

  test("reports false instead of throwing on escape", () => {
    expect(isInside("/data/repo", "../etc/passwd")).toBe(false);
  });

  test("reports false for invalid candidates", () => {
    expect(isInside("/data/repo", "")).toBe(false);
  });
});

describe("assertSafeGitRevision", () => {
  test("accepts a tree hash", () => {
    const hash = "a".repeat(40);
    expect(assertSafeGitRevision(hash)).toBe(hash);
  });

  test("accepts HEAD and named refs", () => {
    expect(assertSafeGitRevision("HEAD")).toBe("HEAD");
    expect(assertSafeGitRevision("main")).toBe("main");
    expect(assertSafeGitRevision("feature/branch-1")).toBe("feature/branch-1");
  });

  test("rejects a shell injection attempt", () => {
    expect(() => assertSafeGitRevision("x; touch /tmp/pwned")).toThrow(
      InvalidPathError
    );
  });

  test("rejects command substitution", () => {
    expect(() => assertSafeGitRevision("$(touch /tmp/pwned)")).toThrow(
      InvalidPathError
    );
  });

  test("rejects backtick substitution", () => {
    expect(() => assertSafeGitRevision("`touch /tmp/pwned`")).toThrow(
      InvalidPathError
    );
  });

  test("rejects a leading dash that git would read as an option", () => {
    expect(() => assertSafeGitRevision("--upload-pack=touch")).toThrow(
      InvalidPathError
    );
  });

  test("rejects a revision range", () => {
    expect(() => assertSafeGitRevision("HEAD...main")).toThrow(
      InvalidPathError
    );
  });

  test("rejects whitespace", () => {
    expect(() => assertSafeGitRevision("abc def")).toThrow(InvalidPathError);
  });

  test("rejects an empty revision", () => {
    expect(() => assertSafeGitRevision("")).toThrow(InvalidPathError);
  });

  test("rejects an over-long revision", () => {
    expect(() => assertSafeGitRevision("a".repeat(513))).toThrow(
      InvalidPathError
    );
  });
});
