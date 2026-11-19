import { createLogger } from "@chorus/logger";
import {
  DEFAULT_OPENCODE_HOSTNAME,
  DEFAULT_OPENCODE_PORT,
  LIVENESS_INTERVAL_MS,
  MAX_MISSED_PROBES,
  MAX_RESTARTS,
} from "./constants";
import { EngineUnavailableError } from "./errors";
import { probeOpenCodeHealth } from "./health";
import { createOpenCodeEnvironment, resolveOpenCodeBinary } from "./runtime";

const logger = createLogger({ env: "development" }, "SERVE");

type EngineSpawner = (
  port: number,
  hostname: string
) => ReturnType<typeof Bun.spawn>;

export class OpenCodeProcessManager {
  #proc: ReturnType<typeof Bun.spawn> | null = null;
  readonly #port: number;
  readonly #hostname: string;
  readonly #baseUrl: string;
  readonly #authorization: string | undefined;
  readonly #directory: string;
  readonly #databasePath: string | undefined;
  readonly #readinessTimeoutMs: number;
  readonly #maxRestarts: number;
  #observedVersion: string | null = null;
  #ready = false;
  readonly #expectedVersion: string | undefined;
  readonly #adoptExisting: boolean;
  readonly #spawnEngine: EngineSpawner | undefined;
  #owned = false;
  #stopping = false;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #livenessTimer: ReturnType<typeof setInterval> | null = null;
  #missedProbes = 0;
  // Ignore exit callbacks from children that have already been replaced.
  #generation = 0;

  constructor(options: {
    port?: number;
    hostname?: string;
    baseUrl?: string;
    username?: string;
    password?: string;
    directory: string;
    databasePath?: string;
    readinessTimeoutMs?: number;
    maxRestarts?: number;
    expectedVersion?: string;
    adoptExisting?: boolean;
    spawnEngine?: EngineSpawner;
  }) {
    this.#port = options.port ?? DEFAULT_OPENCODE_PORT;
    this.#hostname = options.hostname ?? DEFAULT_OPENCODE_HOSTNAME;
    this.#baseUrl =
      options.baseUrl ?? `http://${this.#hostname}:${String(this.#port)}`;
    this.#authorization =
      options.username && options.password
        ? `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
        : undefined;
    this.#directory = options.directory;
    this.#databasePath = options.databasePath;
    this.#expectedVersion = options.expectedVersion;
    this.#adoptExisting = options.adoptExisting ?? true;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
    this.#maxRestarts = options.maxRestarts ?? MAX_RESTARTS;
    this.#spawnEngine = options.spawnEngine;
  }

  get port(): number {
    return this.#port;
  }

  get observedVersion(): string | null {
    return this.#observedVersion;
  }

  get ready(): boolean {
    return this.#ready;
  }

  async assertReady(expectedVersion = this.#expectedVersion): Promise<void> {
    const health = await probeOpenCodeHealth(
      this.#baseUrl,
      2000,
      this.#authorization
    );
    if (!health?.healthy) {
      this.#ready = false;
      throw new EngineUnavailableError(
        `OpenCode engine at ${this.#baseUrl} is unavailable or unhealthy`
      );
    }
    this.#observedVersion = health.version ?? null;
    if (!(this.#observedVersion && expectedVersion)) {
      this.#ready = false;
      throw new EngineUnavailableError(
        "OpenCode engine readiness cannot be verified because its version is unknown"
      );
    }
    if (this.#observedVersion !== expectedVersion) {
      this.#ready = false;
      throw new EngineUnavailableError(
        `OpenCode engine version ${this.#observedVersion} does not match the required SDK version ${expectedVersion}`
      );
    }
    this.#ready = true;
  }

  async probeVersion(): Promise<string | null> {
    const health = await probeOpenCodeHealth(
      this.#baseUrl,
      2000,
      this.#authorization
    );
    this.#observedVersion = health?.healthy ? (health.version ?? null) : null;
    this.#ready = false;
    return this.#observedVersion;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#ready = false;
    const existing = await probeOpenCodeHealth(
      this.#baseUrl,
      1000,
      this.#authorization
    );
    if (this.#stopping) {
      throw new EngineUnavailableError("engine startup was cancelled");
    }
    if (existing?.healthy) {
      this.#observedVersion = existing.version ?? null;
      if (!this.#adoptExisting) {
        throw new Error(
          `engine port ${String(this.#port)} is already occupied`
        );
      }
      this.#assertVersion(this.#observedVersion);
      this.#owned = false;
      this.#ready = true;
      logger.info("opencode-already-running", {
        hostname: this.#hostname,
        observedVersion: this.#observedVersion ?? "unknown",
        port: this.#port,
      });
      return;
    }
    if (existing && !existing.healthy) {
      this.#ready = false;
      throw new Error(
        `OpenCode at ${this.#baseUrl} reports an unhealthy state`
      );
    }

    logger.info("opencode-starting", {
      directory: this.#directory,
      hostname: this.#hostname,
      port: this.#port,
    });

    this.#owned = true;
    try {
      this.#spawn();
      await this.#awaitReady();
      this.#startLivenessChecks();
    } catch (error) {
      // Failed startup must not leave a detached child running.
      await this.stop();
      throw error;
    }
  }

  #startLivenessChecks(): void {
    this.#stopLivenessChecks();

    this.#livenessTimer = setInterval(() => {
      if (this.#stopping || !this.#owned) {
        return;
      }

      const generation = this.#generation;
      probeOpenCodeHealth(this.#baseUrl, 2000, this.#authorization).then(
        (health) => {
          if (this.#stopping || generation !== this.#generation) {
            return;
          }
          if (health?.healthy) {
            this.#missedProbes = 0;
            return;
          }

          this.#missedProbes += 1;

          if (this.#missedProbes < MAX_MISSED_PROBES) {
            return;
          }

          logger.warn("opencode-unresponsive", {
            missedProbes: this.#missedProbes,
            port: this.#port,
          });
          this.#ready = false;
          this.#missedProbes = 0;

          this.#recycle("unresponsive");
        }
      );
    }, LIVENESS_INTERVAL_MS);

    this.#livenessTimer.unref?.();
  }

  #stopLivenessChecks(): void {
    if (this.#livenessTimer) {
      clearInterval(this.#livenessTimer);
      this.#livenessTimer = null;
    }
  }

  async #awaitReady(): Promise<void> {
    const deadline = Date.now() + this.#readinessTimeoutMs;

    while (Date.now() < deadline) {
      if (!this.#proc) {
        throw new Error(
          `opencode exited during startup on port ${String(this.#port)}`
        );
      }

      const health = await probeOpenCodeHealth(
        this.#baseUrl,
        1000,
        this.#authorization
      );
      if (this.#stopping) {
        throw new EngineUnavailableError("engine startup was cancelled");
      }
      if (health?.healthy) {
        this.#observedVersion = health.version ?? null;
        this.#assertVersion(this.#observedVersion);
        this.#ready = true;
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

  #assertVersion(observed: string | null): void {
    if (this.#expectedVersion && observed !== this.#expectedVersion) {
      this.#ready = false;
      throw new EngineUnavailableError(
        observed
          ? `OpenCode engine version ${observed} does not match the required SDK version ${this.#expectedVersion}`
          : "OpenCode engine readiness cannot be verified because its version is unknown"
      );
    }
  }

  #recycle(reason: string): void {
    this.#restart(reason);
  }

  #supersedeCurrent(): void {
    this.#ready = false;
    const previous = this.#proc;
    this.#generation += 1;
    this.#proc = null;

    if (previous) {
      previous.kill("SIGKILL");
    }
  }

  #restart(reason: string): void {
    this.#ready = false;
    this.#stopLivenessChecks();
    // The old child may still hold the port while it is alive but unresponsive.
    this.#supersedeCurrent();

    if (this.#stopping || !this.#owned) {
      return;
    }

    this.#spawn();
    this.#awaitReady()
      .then(() => {
        if (!this.#stopping) {
          this.#restartAttempts = 0;
          this.#startLivenessChecks();
        }
      })
      .catch((error: unknown) => {
        logger.error(
          "opencode-restart-not-ready",
          error instanceof Error ? error : undefined,
          { reason }
        );

        if (this.#proc === null) {
          return;
        }

        this.#scheduleRestart(reason);
      });
  }

  #spawn(): void {
    const proc =
      this.#spawnEngine?.(this.#port, this.#hostname) ??
      Bun.spawn(
        [
          resolveOpenCodeBinary(),
          "serve",
          "--port",
          String(this.#port),
          "--hostname",
          this.#hostname,
        ],
        {
          cwd: this.#directory,
          env: this.#databasePath
            ? createOpenCodeEnvironment(this.#databasePath)
            : { ...process.env },
          // Shutdown must stop the child after Serve flushes state.
          detached: true,
          stderr: "pipe",
          stdout: "pipe",
          windowsHide: true,
        }
      );

    this.#proc = proc;
    this.#generation += 1;

    this.#consumeStream(
      proc.stdout as ReadableStream<Uint8Array>,
      "opencode-stdout"
    );
    this.#consumeStream(
      proc.stderr as ReadableStream<Uint8Array>,
      "opencode-stderr"
    );

    const generation = this.#generation;

    const onExit = (detail: string, error?: unknown): void => {
      if (generation !== this.#generation) {
        return;
      }

      if (this.#proc === proc) {
        this.#proc = null;
      }
      this.#ready = false;

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

  #scheduleRestart(reason: string): void {
    if (this.#stopping || !this.#owned) {
      return;
    }

    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }

    if (this.#restartAttempts >= this.#maxRestarts) {
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
      this.#restart(reason);
    }, delayMs);

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
          // Provider output can contain credentials, so only log activity.
          logger.debug(label, { characters: text.length });
        }
      }
    } catch {
      return;
    }
  }

  beginShutdown(): void {
    this.#stopping = true;
    this.#ready = false;
    this.#stopLivenessChecks();
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.beginShutdown();

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
    this.beginShutdown();

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
