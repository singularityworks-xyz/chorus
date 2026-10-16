import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Container build only: no third-party install scripts, downloads, npm fallback,
// CPU feature probes, or process startup. x64 always uses the portable baseline.
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error(
    "the container engine installer supports Linux x64/arm64 only"
  );
}
const require = createRequire(
  new URL("../apps/serve/package.json", import.meta.url)
);
const manifest = require.resolve("opencode-ai/package.json");
function version(filename: string): string {
  const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("invalid installed engine manifest");
  }
  return value.version;
}
const expected = version(manifest);
if (expected !== "1.19.0") {
  throw new Error(
    "review the container engine layout when changing its pinned version"
  );
}
const engineRequire = createRequire(manifest);
const nativePackage =
  process.arch === "x64"
    ? "opencode-linux-x64-baseline"
    : "opencode-linux-arm64";
const nativeManifest = engineRequire.resolve(`${nativePackage}/package.json`);
if (version(nativeManifest) !== expected) {
  throw new Error("the installed engine packages disagree");
}
const target = join(dirname(manifest), "bin", "opencode.exe");
mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) {
  unlinkSync(target);
}
copyFileSync(join(dirname(nativeManifest), "bin", "opencode"), target);
chmodSync(target, 0o755);
