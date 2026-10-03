import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Owns the serve process so a test can actually restart it.
 *
 * Playwright's `webServer` supervises its own process and offers no way to stop
 * and start it from inside a spec, but "the server went away mid-session and the
 * client came back" is a real failure mode with real consequences: the socket
 * drops, backoff has to kick in, and the resume cursor has to be honoured
 * against a process that has no memory of the connection. Simulating that with
 * `context.setOffline` only exercises the client half -- it never proves the
 * server accepted the replay. So serve is spawned here instead, and its pid is
 * published to a file the specs can read.
 *
 * `stop` is exported for global teardown. Nothing else should ever kill it: a
 * leftover serve on the port would be reused by the next run and silently
 * inherit a stale event log, which is exactly the kind of cross-run state that
 * makes a sync suite lie.
 */

export interface ServeProcessOptions {
  dataDir: string;
  /** Extra env for the child; used to point serve at the shared engine. */
  env?: Record<string, string>;
  logFile: string;
  pidFile: string;
  port: number;
  repoRoot: string;
  token: string;
}

/** Writes a pid file so specs in a worker can find the process to restart. */
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

/** Spawns serve and resolves once `/health` answers, or rejects on timeout. */
export async function start(options: ServeProcessOptions): Promise<number> {
  const child = spawn("bun", ["run", "apps/serve/src/index.ts"], {
    cwd: options.repoRoot,
    env: {
      ...process.env,
      CHORUS_TOKEN: options.token,
      DATA_DIR: options.dataDir,
      NODE_ENV: "production",
      OPENCODE_AUTO_START: "false",
      PORT: String(options.port),
      // Spread last so a caller can point serve at an engine it did not spawn.
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Without a consumer the pipe fills and the child blocks on write, which
  // shows up as a health check that times out for no visible reason.
  const log = spawn("tee", ["-a", options.logFile], { stdio: "pipe" });
  child.stdout?.pipe(log.stdin);
  child.stderr?.pipe(log.stdin);

  child.unref();
  recordPid(options.pidFile, child.pid ?? -1);

  await waitForHealth(options.port, 30_000);
  return child.pid ?? -1;
}

/**
 * Stops serve and waits for the port to be released.
 *
 * Resolves even if the process is already gone: a restart test may have been
 * retried after a partial run, and "it was not running" is not a failure.
 */
export async function stop(port: number, pidFile: string): Promise<void> {
  const pid = readPid(pidFile);

  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }

  await waitForPortFree(port, 15_000);
}

/**
 * Resolves when `/health` answers 200.
 *
 * Polls rather than waiting on the child's exit, because a serve that boots and
 * immediately fails has no output the parent can interpret more clearly than
 * "the port never opened".
 */
async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await healthOnce(port)) {
      return;
    }
    await delay(200);
  }

  throw new Error(`serve did not become healthy on port ${String(port)}`);
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await healthOnce(port))) {
      return;
    }
    await delay(200);
  }

  throw new Error(`serve is still listening on port ${String(port)}`);
}

async function healthOnce(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Starts the opencode engine and resolves once it reports healthy.
 *
 * Not managed by Playwright's `webServer`: spawning `opencode serve` from there
 * proved unreliable — the child would intermittently die while the readiness wait
 * ran to its full timeout, with nothing in the output to say why. Starting it
 * here means the wait, the retries and the log all belong to us.
 *
 * `/global/health` is the readiness target because `opencode serve` answers 200
 * with an HTML shell for any unknown path.
 */
export async function startEngine(options: {
  cwd: string;
  logFile: string;
  pidFile: string;
  port: number;
}): Promise<number> {
  const child = spawn(
    "opencode",
    ["serve", "--port", String(options.port), "--hostname", "127.0.0.1"],
    {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const log = spawn("tee", ["-a", options.logFile], { stdio: "pipe" });
  child.stdout?.pipe(log.stdin);
  child.stderr?.pipe(log.stdin);
  child.unref();
  recordPid(options.pidFile, child.pid ?? -1);

  await waitForHealth(options.port, 120_000);
  return child.pid ?? -1;
}
