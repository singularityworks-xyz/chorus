import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { InvalidPathError, SandboxEscapeError } from "./paths/sandbox";
import { resolveStaticPath, setStaticRoot } from "./web-frontend";

const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "chorus-web-"));
  roots.push(dir);
  setStaticRoot(dir);
  return dir;
}

afterEach(() => {
  const dir = roots.pop();
  if (dir) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("resolveStaticPath", () => {
  test("maps the root to index.html", () => {
    const root = makeRoot();

    expect(resolveStaticPath("/")).toBe(join(root, "index.html"));
  });

  test("resolves a normal asset inside the root", () => {
    const root = makeRoot();

    expect(resolveStaticPath("/_next/static/chunk.js")).toBe(
      join(root, "_next/static/chunk.js")
    );
  });

  test("rejects relative traversal", () => {
    makeRoot();

    for (const attack of [
      "/../secrets",
      "/../../etc/passwd",
      "/_next/../../../../etc/shadow",
      "/a/b/../../../escape",
    ]) {
      expect(() => resolveStaticPath(attack)).toThrow(SandboxEscapeError);
    }
  });

  test("rejects percent-encoded traversal", () => {
    makeRoot();

    for (const attack of [
      "/%2e%2e/%2e%2e/etc/passwd",
      "/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
    ]) {
      expect(() => resolveStaticPath(attack)).toThrow(SandboxEscapeError);
    }
  });

  test("rejects a backslash-separated traversal", () => {
    makeRoot();

    expect(() => resolveStaticPath("/..\\..\\windows\\system32")).toThrow();
  });

  test("rejects a NUL byte", () => {
    makeRoot();

    expect(() => resolveStaticPath("/index.html\0.png")).toThrow(
      InvalidPathError
    );
  });

  test("rejects a malformed percent escape instead of throwing a TypeError", () => {
    makeRoot();

    expect(() => resolveStaticPath("/%zz")).toThrow(InvalidPathError);
  });

  test("rejects a symlink inside the root that points outside it", () => {
    const root = makeRoot();

    const outside = mkdtempSync(join(tmpdir(), "chorus-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(
      outside,
      join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );

    expect(() => resolveStaticPath("/escape/secret.txt")).toThrow(
      SandboxEscapeError
    );
  });

  test("rejects a prefix-sibling directory", () => {
    const root = makeRoot();

    const siblingName = `${basename(root)}-sibling`;

    expect(() => resolveStaticPath(`/../${siblingName}`)).toThrow(
      SandboxEscapeError
    );
  });
});
