import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");
const childProcessPreload = resolve(
  process.cwd(),
  "e2e/windows-hide-child-processes.cjs"
);
const preloadPathForNode = childProcessPreload.replaceAll("\\", "/");
const preloadOption = `--require="${preloadPathForNode}"`;
const nodeOptions = [process.env.NODE_OPTIONS?.trim(), preloadOption]
  .filter(Boolean)
  .join(" ");

const child = spawn("node", [playwrightCli, "test", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: "inherit",
  windowsHide: true,
});

const forwardSignal = (signal: NodeJS.Signals) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.once("SIGINT", forwardSignal.bind(null, "SIGINT"));
process.once("SIGTERM", forwardSignal.bind(null, "SIGTERM"));

child.once("error", (error) => {
  process.stderr.write(`Unable to start Playwright: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("close", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
