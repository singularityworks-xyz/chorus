import { createLogger } from "@chorus/logger";

const logger = createLogger({ env: "development" }, "SERVE");

const OPENCODE_PORT = 4096;
const OPENCODE_HOSTNAME = "127.0.0.1";

/**
 * The one opencode endpoint that is not the SPA fallback.
 *
 * `opencode serve` answers 200 with an HTML shell for *any* unknown path, so a
 * status check cannot tell a live server from a squatter on the port. This path
 * returns JSON, and it carries the running binary's version — which is what
 * makes it both a readiness gate and the identity check that decision #5's
 * lockstep assertion needs.
 */
const HEALTH_PATH = "/global/health";

interface HealthPayload {
  healthy: boolean;
  version?: string;
}

async function probeHealth(
  port: number,
  host: string,
  timeoutMs: number
): Promise<HealthPayload | null> {
  try {
    const response = await fetch(
      `http://${host}:${String(port)}${HEALTH_PATH}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    if (!response.ok) {
      return null;
    }

    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const candidate = parsed as Partial<HealthPayload>;
    return {
      healthy: candidate.healthy === true,
      version:
        typeof candidate.version === "string" ? candidate.version : undefined,
    };
  } catch {
    return null;
  }
}

export class OpenCodeProcessManager {
  #proc: ReturnType<typeof Bun.spawn> | null = null;
  readonly #port: number;
  readonly #hostname: string;
  readonly #directory: string;
  readonly #readinessTimeoutMs: number;
  /** Version the spawned binary reported, once it has answered a health probe. */
  #observedVersion: string | null = null;
  /** True when we spawned it and are therefore responsible for stopping it. */
  #owned = false;
  #stopping = false;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive failed health probes before the engine is treated as gone. */
  #missedProbes = 0;
  /**
   * Pids we have deliberately replaced.
   *
   * Their exit handlers would otherwise act on current state: clearing the live
   * child's handle and scheduling a restart of a process that is already the
   * replacement.
   */
  readonly #superseded = new Set<number | undefined>();

  constructor(options: {
    port?: number;
    hostname?: string;
    directory: string;
    readinessTimeoutMs?: number;
    maxRestarts?: number;
  }) {
    this.#port = options.port ?? OPENCODE_PORT;
    this.#hostname = options.hostname ?? OPENCODE_HOSTNAME;
    this.#directory = options.directory;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
  }

  get port(): number {
    return this.#port;
  }

  /**
   * The running binary's own reported version, or null if it never answered.
   *
   * Read from the process rather than from `opencode --version` on PATH: the
   * point is to learn what is *actually* serving, which is not necessarily the
   * binary we would have spawned.
   */
  get observedVersion(): string | null {
    return this.#observedVersion;
  }

  /**
   * Reads the running engine's version without starting one.
   *
   * The lockstep assertion needs the adopted engine's version even when
   * auto-start is off, and starting an engine the operator did not ask for to
   * find that out would be the wrong trade.
   */
  async probeVersion(): Promise<string | null> {
    const health = await probeHealth(this.#port, this.#hostname, 2000);
    this.#observedVersion = health?.version ?? null;
    return this.#observedVersion;
  }

  async start(): Promise<void> {
    const existing = await probeHealth(this.#port, this.#hostname, 1000);
    if (existing) {
      this.#observedVersion = existing.version ?? null;
      this.#owned = false;
      logger.info("opencode-already-running", {
        hostname: this.#hostname,
        observedVersion: this.#observedVersion ?? "unknown",
        port: this.#port,
      });
      return;
    }

    logger.info("opencode-starting", {
      directory: this.#directory,
      hostname: this.#hostname,
      port: this.#port,
    });

    this.#stopping = false;
    this.#owned = true;
    this.#spawn();
    await this.#awaitReady();
    this.#startLivenessChecks();
  }

  /**
   * Polls the engine periodically and restarts it if it stops answering.
   *
   * The exit handler only catches an engine that dies loudly. An engine that
   * wedges — alive as a process, no longer answering — leaves serve spawning
   * sessions against a socket that will never reply, with nothing in any log to
   * distinguish it from a slow model.
   *
   * Only for an engine we spawned: one serve adopted is somebody else's to
   * restart, and killing it because a probe timed out would be wrong.
   */
  #startLivenessChecks(): void {
    this.#stopLivenessChecks();

    this.#livenessTimer = setInterval(() => {
      if (this.#stopping || !this.#owned) {
        return;
      }

      probeHealth(this.#port, this.#hostname, 2000).then((health) => {
        if (health?.healthy) {
          this.#missedProbes = 0;
          return;
        }

        this.#missedProbes += 1;

        // A single missed probe is usually a busy moment, not a dead engine.
        if (this.#missedProbes < MAX_MISSED_PROBES) {
          return;
        }

        logger.warn("opencode-unresponsive", {
          missedProbes: this.#missedProbes,
          port: this.#port,
        });
        this.#missedProbes = 0;

        // Kill it first. The wedged process still holds the port, so spawning a
        // replacement without stopping it does not restart anything — the new
        // child fails to bind and exits, leaving one orphan and one corpse.
        this.#recycle("unresponsive");
      });
    }, LIVENESS_INTERVAL_MS);

    this.#livenessTimer.unref?.();
  }

  #stopLivenessChecks(): void {
    if (this.#livenessTimer) {
      clearInterval(this.#livenessTimer);
      this.#livenessTimer = null;
    }
  }

  /**
   * Blocks until the server answers, or throws.
   *
   * Previously `start()` returned as soon as `Bun.spawn` did, so `bridge.start()`
   * immediately afterwards raced the server's own boot and the first request of a
   * fresh process failed against a socket that was not listening yet.
   */
  async #awaitReady(): Promise<void> {
    const deadline = Date.now() + this.#readinessTimeoutMs;

    while (Date.now() < deadline) {
      if (!this.#proc) {
        throw new Error(
          `opencode exited during startup on port ${String(this.#port)}`
        );
      }

      const health = await probeHealth(this.#port, this.#hostname, 1000);
      if (health?.healthy) {
        this.#observedVersion = health.version ?? null;
        logger.info("opencode-ready", {
          observedVersion: this.#observedVersion ?? "unknown",
          port: this.#port,
        });
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    }

    throw new Error(
      `opencode did not become ready on port ${String(this.#port)} within ${String(this.#readinessTimeoutMs)}ms`
    );
  }

  /**
   * Replaces a running engine: kill, wait, respawn, re-arm.
   *
   * The only path that restarts a process we own, whether it exited on its own or
   * stopped answering. Keeping it single means the liveness timer and the exit
   * handler cannot each start a process.
   */
  #recycle(reason: string): void {
    this.#stopLivenessChecks();

    const previous = this.#proc;
    this.#proc = null;

    if (previous) {
      // Necessary when the process is alive but wedged; harmless when it already
      // exited.
      previous.kill("SIGKILL");
      this.#superseded.add(previous.pid);
    }

    if (this.#stopping || !this.#owned) {
      return;
    }

    this.#spawn();
    this.#awaitReady()
      .then(() => {
        if (!this.#stopping) {
          this.#startLivenessChecks();
        }
      })
      .catch((error: unknown) => {
        logger.error(
          "opencode-recycle-failed",
          error instanceof Error ? error : undefined,
          { reason }
        );
        // Re-arm so a failed restart is retried rather than leaving the engine
        // unmonitored for the rest of the process's life.
        this.#scheduleRestart(reason);
      });
  }

  #spawn(): void {
    const proc = Bun.spawn(
      [
        "opencode",
        "serve",
        "--port",
        String(this.#port),
        "--hostname",
        this.#hostname,
      ],
      {
        cwd: this.#directory,
        env: { ...process.env },
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    this.#proc = proc;

    this.#consumeStream(
      proc.stdout as ReadableStream<Uint8Array>,
      "opencode-stdout"
    );
    this.#consumeStream(
      proc.stderr as ReadableStream<Uint8Array>,
      "opencode-stderr"
    );

    const pid = proc.pid;

    const onExit = (detail: string, error?: unknown): void => {
      if (this.#superseded.delete(pid)) {
        // A process we already replaced. Its exit must not clear the live child's
        // handle or schedule a restart of its own.
        return;
      }

      if (this.#proc === proc) {
        this.#proc = null;
      }

      if (error === undefined) {
        logger.info("opencode-exited", { code: detail });
      } else {
        logger.error(
          "opencode-error",
          error instanceof Error ? error : undefined
        );
      }

      if (!this.#stopping && this.#owned) {
        this.#scheduleRestart(detail);
      }
    };

    proc.exited
      .then((code) => onExit(String(code)))
      .catch((error: unknown) => onExit("error", error));
  }

  /**
   * Re-spawns after an unexpected exit.
   *
   * Nothing used to: `start()` ran once at boot and the child was never
   * revisited, so a crash left every later prompt failing against a dead port
   * until the whole server was restarted.
   *
   * Bounded and backed off, and never during an intentional shutdown.
   */
  #scheduleRestart(reason: string): void {
    if (this.#stopping || !this.#owned) {
      return;
    }

    if (this.#restartAttempts >= MAX_RESTARTS) {
      logger.error("opencode-restart-exhausted", {
        attempts: this.#restartAttempts,
        reason,
      });
      return;
    }

    this.#restartAttempts += 1;
    const delayMs = Math.min(1000 * 2 ** (this.#restartAttempts - 1), 15_000);
    logger.warn("opencode-restarting", {
      attempt: this.#restartAttempts,
      delayMs,
      reason,
    });

    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (this.#stopping) {
        return;
      }
      this.#spawn();
      this.#awaitReady()
        .then(() => {
          if (!this.#stopping) {
            // A restart that came up healthy earns back the budget, so a long
            // session with occasional crashes is not capped at five for its life.
            this.#restartAttempts = 0;
            this.#startLivenessChecks();
          }
        })
        .catch((error: unknown) => {
          logger.error(
            "opencode-restart-not-ready",
            error instanceof Error ? error : undefined
          );
        });
    }, delayMs);

    // Never hold the process open purely to restart a child.
    this.#restartTimer.unref?.();
  }

  #restartAttempts = 0;

  async #consumeStream(
    stream: ReadableStream<Uint8Array>,
    label: string
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text = new TextDecoder().decode(value).trim();
        if (text) {
          logger.debug(label, { data: text });
        }
      }
    } catch {
      // stream closed, ignore
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#stopLivenessChecks();
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }

    const proc = this.#proc;
    if (!proc) {
      return;
    }

    logger.info("opencode-stopping");
    this.#proc = null;
    proc.kill("SIGTERM");
    await proc.exited.catch(() => undefined);
  }

  async forceKill(): Promise<void> {
    this.#stopping = true;
    this.#stopLivenessChecks();
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }

    const proc = this.#proc;
    if (!proc) {
      return;
    }

    logger.info("opencode-force-kill");
    this.#proc = null;
    proc.kill("SIGKILL");
    await proc.exited.catch(() => undefined);
  }
}

const MAX_RESTARTS = 5;

/** How often the engine is probed once it is up. */
const LIVENESS_INTERVAL_MS = 15_000;

/** Consecutive failed probes tolerated before declaring the engine gone. */
const MAX_MISSED_PROBES = 3;
