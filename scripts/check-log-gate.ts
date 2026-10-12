import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SourceFile {
  path: string;
  source: string;
}

const CALL_SITE =
  /(?:console|logger)\.(?:log|info|warn|error|debug|trace)\s*\(/;
const SENSITIVE_WORD =
  /(?:token|password|passwd|secret|api[_-]?key|key=|authorization|bearer)/i;
const LINE_SEPARATOR = /\r?\n/;
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;
const DECLARATION_FILE = /\.d\.ts$/;

export function findSensitiveLogCalls(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    if (
      !SOURCE_FILE.test(file.path) ||
      TEST_FILE.test(file.path) ||
      DECLARATION_FILE.test(file.path)
    ) {
      continue;
    }

    for (const [index, line] of file.source.split(LINE_SEPARATOR).entries()) {
      if (CALL_SITE.test(line) && SENSITIVE_WORD.test(line)) {
        violations.push(`${file.path}:${index + 1}:${line.trim()}`);
      }
    }
  }

  return violations;
}

function trackedSourceFiles(root: string): SourceFile[] {
  const result = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "apps",
      "packages",
    ],
    { cwd: root, stderr: "pipe", stdout: "pipe" }
  );

  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(
      `could not list source files with git${detail ? `: ${detail}` : ""}`
    );
  }

  const paths = new TextDecoder().decode(result.stdout).split("\0");
  return paths
    .filter((path) => path.length > 0)
    .filter(
      (path) =>
        SOURCE_FILE.test(path) &&
        !TEST_FILE.test(path) &&
        !DECLARATION_FILE.test(path)
    )
    .map((path) => ({
      path,
      source: readFileSync(resolve(root, path), "utf8"),
    }));
}

function run(): void {
  const root = fileURLToPath(new URL("../", import.meta.url));
  let violations: string[];

  try {
    violations = findSensitiveLogCalls(trackedSourceFiles(root));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`log-gate: could not run: ${detail}`);
    process.exitCode = 2;
    return;
  }

  if (violations.length === 0) {
    console.log(
      "log-gate: ok (no sensitive keywords in log/console call sites)"
    );
    return;
  }

  console.error(
    `log-gate: FAILED — ${violations.length} log/console call site(s) mention a sensitive keyword.\n\n` +
      "Never log tokens, passwords, secrets, or API keys. Log a boolean 'hasToken' or a redacted fingerprint instead.\n\n" +
      violations.map((violation) => `  ${violation}`).join("\n")
  );
  process.exitCode = 1;
}

if (import.meta.main) {
  run();
}
