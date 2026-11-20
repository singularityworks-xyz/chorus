import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";

const packageManifestSchema = z.object({
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});
const serveRequire = createRequire(
  join(process.cwd(), "apps/serve/package.json")
);

function resolveOpenCodeBinary(): string {
  const manifestPath = serveRequire.resolve("opencode-ai/package.json");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifest = packageManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    throw new Error("The pinned opencode-ai package has no CLI entrypoint");
  }
  const binary =
    typeof manifest.data.bin === "string"
      ? manifest.data.bin
      : manifest.data.bin.opencode;
  if (!binary) {
    throw new Error("The pinned opencode-ai package has no opencode binary");
  }
  return join(dirname(manifestPath), binary);
}

export interface ServeProcessOptions {
  dataDir: string;

  env?: Record<string, string>;
  logFile: string;
  pidFile: string;
  port: number;
  repoRoot: string;
  token: string;
}

export function recordPid(pidFile: string, pid: number): void {
  writeFileSync(pidFile, String(pid), "utf8");
}

export function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) {
    return null;
  }

  const parsed = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function start(options: ServeProcessOptions): Promise<number> {
  const child = spawn("bun", ["run", "apps/serve/src/index.ts"], {
    cwd: options.repoRoot,
    env: {
      ...process.env,
      CHORUS_TOKEN: options.token,
      DATA_DIR: options.dataDir,

      NODE_ENV: "development",
      OPENCODE_AUTO_START: "false",
      PORT: String(options.port),

      ...options.env,
    },

    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const log = createWriteStream(options.logFile, { flags: "a" });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once("close", (code, signal) => {
    log.write(
      `[e2e] serve exited: code=${String(code)} signal=${String(signal)}\n`
    );
    log.end();
  });

  child.unref();
  recordPid(options.pidFile, child.pid ?? -1);

  await waitForChildHealth(child, options.port, 120_000, "serve");
  return child.pid ?? -1;
}

export async function stop(
  port: number,
  pidFile: string,
  kind: "engine" | "serve" = "serve"
): Promise<void> {
  const pid = readPid(pidFile);

  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }

  await waitForPortFree(port, 15_000, kind);
}

async function waitForHealth(
  port: number,
  timeoutMs: number,
  kind: "serve" | "engine" = "serve"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await healthOnce(port, kind)) {
      return;
    }
    await delay(200);
  }

  throw new Error(`${kind} did not become healthy on port ${String(port)}`);
}

async function waitForPortFree(
  port: number,
  timeoutMs: number,
  kind: "engine" | "serve"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await healthOnce(port, kind))) {
      return;
    }
    await delay(200);
  }

  throw new Error(`${kind} is still listening on port ${String(port)}`);
}

async function healthOnce(
  port: number,
  kind: "serve" | "engine"
): Promise<boolean> {
  const path = kind === "engine" ? "/global/health" : "/health";

  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      signal: AbortSignal.timeout(1000),
    });

    if (!response.ok) {
      return false;
    }

    if (kind === "engine") {
      const body: unknown = await response.json();
      return (
        typeof body === "object" &&
        body !== null &&
        (body as { healthy?: unknown }).healthy === true
      );
    }

    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function startEngine(options: {
  cwd: string;
  logFile: string;
  pidFile: string;
  port: number;
}): Promise<number> {
  const child = spawn(
    process.env.CHORUS_E2E_AGENT === "1" ? resolveOpenCodeBinary() : "bun",
    process.env.CHORUS_E2E_AGENT === "1"
      ? ["serve", "--port", String(options.port), "--hostname", "127.0.0.1"]
      : ["e2e/scripted-engine.ts", String(options.port)],
    {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  const log = createWriteStream(options.logFile, { flags: "a" });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once("close", () => log.end());
  child.unref();
  recordPid(options.pidFile, child.pid ?? -1);

  await waitForChildHealth(child, options.port, 120_000, "engine");
  return child.pid ?? -1;
}

async function waitForChildHealth(
  child: ReturnType<typeof spawn>,
  port: number,
  timeoutMs: number,
  kind: "engine" | "serve"
): Promise<void> {
  const startupError = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
  });
  try {
    await Promise.race([waitForHealth(port, timeoutMs, kind), startupError]);
  } catch (error) {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Startup may have failed before a process was created.
      }
    }
    throw new Error(
      `${kind} process failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
