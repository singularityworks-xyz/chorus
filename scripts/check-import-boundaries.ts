import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([
  ".next",
  ".turbo",
  "dist",
  "node_modules",
]);
const SDK_IMPORT =
  /\b(?:from\s*|import\s*\(|require(?:\.resolve)?\s*\()\s*["']@opencode-ai\/sdk(?:\/v2)?["']/g;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...(await sourceFiles(join(directory, entry.name))));
      }
      continue;
    }
    if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

const files = await Promise.all(
  ["apps", "packages"].map((directory) => sourceFiles(directory))
);
const violations: string[] = [];

for (const file of files.flat()) {
  const relativePath = relative(process.cwd(), file);
  if (relativePath.startsWith("packages/opencode-adapter/")) {
    continue;
  }

  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(SDK_IMPORT)) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${relativePath}:${line}`);
  }
}

if (violations.length > 0) {
  console.error(
    [
      "OpenCode SDK imports must stay inside packages/opencode-adapter:",
      ...violations,
    ].join("\n")
  );
  process.exitCode = 1;
} else {
  console.log("import-boundaries: ok");
}
