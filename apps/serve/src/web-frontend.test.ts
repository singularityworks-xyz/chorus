import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidPathError, SandboxEscapeError } from "./paths/sandbox";
import { resolveStaticPath, setStaticRoot } from "./web-frontend";

/**
 * Static-path traversal guard (spec §6.4, plan P4.6).
 *
 * `path.join(WEB_PROD_DIR, pathname)` on its own reads and returns any file on
 * the host: a request for `/../../etc/passwd` joins straight out of the web root.
 * These tests pin the rejection, since the HTTP-level coverage in
 * `auth/auth-matrix.test.ts` cannot distinguish "rejected" from "no build
 * present".
 */

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

    // Decoded before resolution, so an encoded separator cannot slip past.
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

    // `decodeURIComponent` throws on `%zz`; that is a client error and must not
    // surface as a 500.
    expect(() => resolveStaticPath("/%zz")).toThrow(InvalidPathError);
  });

  test("rejects a symlink inside the root that points outside it", () => {
    const root = makeRoot();
    // Deliberately not `makeRoot()`: that would re-point the static root and
    // the "root" under test would no longer be the root.
    const outside = mkdtempSync(join(tmpdir(), "chorus-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "escape"));

    // Lexical containment passes this: the path is under the root and uses no
    // `..`. Only realpath resolution catches it.
    expect(() => resolveStaticPath("/escape/secret.txt")).toThrow(
      SandboxEscapeError
    );
  });

  test("rejects a prefix-sibling directory", () => {
    const root = makeRoot();

    // `root` and `root-sibling` share a string prefix but are distinct trees.
    // A naive `startsWith(root)` check would accept the sibling.
    const sibling = `${root}-sibling`;
    roots.push(sibling);

    expect(() => resolveStaticPath(`../${sibling}`)).toThrow(
      SandboxEscapeError
    );
  });
});
