import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVE_SRC = join(import.meta.dir, "..");

const SHELL_EXEC_IMPORT =
  /import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*["']node:child_process["']/;
const PROMISISED_EXEC = /promisify\(\s*exec\s*\)/;
const SHELL_EXEC_CALL = /\bexecAsync\s*\(/;

const SHELL_STRING_TEMPLATE = /(?<![.\w])exec(?:Async)?\s*\(\s*`/;
const EXEC_FILE_ARGUMENT_ARRAY = /execFile\(\s*file,\s*args,/;

function collectSourceFiles(dir: string): string[] {
  const glob = new Bun.Glob("**/*.ts");
  return [...glob.scanSync({ cwd: dir, absolute: true })].filter(
    (file) => !(file.endsWith(".test.ts") || file.endsWith(".d.ts"))
  );
}

const LEGACY_AUTH_LOGIN_SHELL = [
  "cd ",
  "$",
  "{JSON.stringify(directory)}",
].join("");

const LOGIN_COMMAND_LITERAL = 'execFileText("git", [';

describe("no shell-string child process execution", () => {
  test("serve source imports no bare exec and builds no shell command strings", () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(SERVE_SRC)) {
      const source = readFileSync(file, "utf8");

      if (
        SHELL_EXEC_IMPORT.test(source) ||
        PROMISISED_EXEC.test(source) ||
        SHELL_EXEC_CALL.test(source) ||
        SHELL_STRING_TEMPLATE.test(source)
      ) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("execFile call sites pass literal argument arrays", () => {
    const snapshotRepository = readFileSync(
      join(SERVE_SRC, "snapshot", "repository.ts"),
      "utf8"
    );

    expect(snapshotRepository).not.toContain("promisify(exec");
    expect(snapshotRepository).toMatch(EXEC_FILE_ARGUMENT_ARRAY);
    expect(snapshotRepository).toContain(LOGIN_COMMAND_LITERAL);
  });

  test("auth login never interpolates a directory into shell text", () => {
    const authLogin = readFileSync(
      join(SERVE_SRC, "projects", "auth-login.ts"),
      "utf8"
    );

    expect(authLogin).not.toContain(LEGACY_AUTH_LOGIN_SHELL);
    expect(authLogin).toContain("quotePosix");
  });
});
