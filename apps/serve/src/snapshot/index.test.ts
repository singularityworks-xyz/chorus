import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidPathError } from "../paths/sandbox";
import { getGitStatus, restore, track } from "./index";

const INJECTION_MARKER = join(tmpdir(), "chorus-snapshot-pwned");
const TREE_HASH_PATTERN = /^[0-9a-f]{40,64}$/;

let projectDir: string;

function snapshotDirFor(projectPath: string): string {
  return join(
    homedir(),
    ".chorus",
    "snapshots",
    projectPath.replace(/[^a-zA-Z0-9]/g, "_")
  );
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "chorus-snapshot-test-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "test@chorus.local"], {
    cwd: projectDir,
  });
  execFileSync("git", ["config", "user.name", "Chorus Test"], {
    cwd: projectDir,
  });
  writeFileSync(join(projectDir, "app.txt"), "original\n");
  execFileSync("git", ["add", "-A"], { cwd: projectDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: projectDir });
});

afterAll(() => {
  rmSync(projectDir, { force: true, recursive: true });
  rmSync(snapshotDirFor(projectDir), { force: true, recursive: true });
  rmSync(INJECTION_MARKER, { force: true });
});

describe("snapshot git execution", () => {
  test("tracks a tree and returns a tree hash", async () => {
    const hash = await track(projectDir);
    expect(hash).toMatch(TREE_HASH_PATTERN);
  });

  test("restores a tracked tree through argument-array git", async () => {
    const hash = await track(projectDir);
    writeFileSync(join(projectDir, "app.txt"), "mutated\n");
    expect(readFileSync(join(projectDir, "app.txt"), "utf8")).toBe("mutated\n");

    await restore(projectDir, hash);
    expect(readFileSync(join(projectDir, "app.txt"), "utf8")).toBe(
      "original\n"
    );
  });

  test("rejects a shell injection revision without spawning anything", async () => {
    await expect(
      restore(projectDir, "x; touch /tmp/chorus-snapshot-pwned")
    ).rejects.toBeInstanceOf(InvalidPathError);

    expect(existsSync(INJECTION_MARKER)).toBe(false);
  });

  test("rejects command substitution in a revision", async () => {
    await expect(
      restore(projectDir, "$(touch /tmp/chorus-snapshot-pwned)")
    ).rejects.toBeInstanceOf(InvalidPathError);

    expect(existsSync(INJECTION_MARKER)).toBe(false);
  });

  test("rejects option injection in a revision", async () => {
    await expect(restore(projectDir, "--help")).rejects.toBeInstanceOf(
      InvalidPathError
    );
  });

  test("reads git status from a real repository", async () => {
    const status = await getGitStatus(projectDir);
    expect(status.branch).toBe("main");
    expect(status.tracking).toBeNull();
  });
});
