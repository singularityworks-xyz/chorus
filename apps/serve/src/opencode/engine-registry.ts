import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { createLogger } from "@chorus/logger";
import { OpenCodeAdapter } from "@chorus/oc-adapter";
import {
  EngineUnavailableError,
  OpenCodeProcessManager,
} from "./process-manager";

const DEFAULT_ENGINE_LIMIT = 8;
const PORT_ALLOCATION_ATTEMPTS = 3;
const ENGINE_START_TIMEOUT_MS = 5000;

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "SERVE:ENGINE-POOL"
);

export interface ManagedEngine {
  assertReady(expectedVersion?: string): Promise<void>;
  forceKill?(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface EngineEntry {
  activeSessions: Set<string>;
  adapter: OpenCodeAdapter;
  directory: string;
  lastUsedAt: number;
  manager: ManagedEngine;
  protectedUntil: number;
  reconciled: boolean;
}

export interface EngineManagerInput {
  adoptExisting: false;
  baseUrl: string;
  directory: string;
  expectedVersion: string;
  password?: string;
  port: number;
  readinessTimeoutMs: number;
  username?: string;
}

export interface EngineRegistryOptions {
  adapterFactory?: (
    baseUrl: string,
    directory: string,
    auth?: { password: string; username: string }
  ) => OpenCodeAdapter;
  allocatePort?: () => Promise<number>;
  canonicalize?: (directory: string) => Promise<string>;
  expectedVersion: string;
  managerFactory?: (input: EngineManagerInput) => ManagedEngine;
  maxEngines?: number;
  now?: () => number;
  password?: string;
  username?: string;
}

/**
 * Lazily owns one verified local engine for each canonical worktree. Allocation
 * is single-flight by directory and serialized across directories, so two board
 * prompts cannot share a port or exceed the configured process budget.
 */
export class EngineRegistry {
  readonly #expectedVersion: string;
  readonly #maxEngines: number;
  readonly #username: string | undefined;
  readonly #password: string | undefined;
  readonly #managerFactory: (input: EngineManagerInput) => ManagedEngine;
  readonly #adapterFactory: (
    baseUrl: string,
    directory: string,
    auth?: { password: string; username: string }
  ) => OpenCodeAdapter;
  readonly #canonicalize: (directory: string) => Promise<string>;
  readonly #allocatePort: () => Promise<number>;
  readonly #now: () => number;
  readonly #entries = new Map<string, EngineEntry>();
  readonly #pending = new Map<string, Promise<EngineEntry>>();
  readonly #aliases = new Map<string, string>();
  readonly #managers = new Set<ManagedEngine>();
  #stopped = false;
  #allocationTail: Promise<void> = Promise.resolve();
  #evictionHandler: ((directory: string) => void) | null = null;

  constructor(options: EngineRegistryOptions) {
    this.#expectedVersion = options.expectedVersion;
    this.#maxEngines = options.maxEngines ?? DEFAULT_ENGINE_LIMIT;
    this.#username = options.username;
    this.#password = options.password;
    this.#managerFactory =
      options.managerFactory ?? ((input) => new OpenCodeProcessManager(input));
    this.#adapterFactory =
      options.adapterFactory ??
      ((baseUrl, directory, auth) =>
        OpenCodeAdapter.from({ baseUrl, directory, auth }));
    this.#canonicalize = options.canonicalize ?? realpath;
    this.#allocatePort = options.allocatePort ?? findAvailablePort;
    this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#maxEngines) || this.#maxEngines < 1) {
      throw new Error("engine pool limit must be a positive integer");
    }
  }

  setEvictionHandler(handler: (directory: string) => void): void {
    this.#evictionHandler = handler;
  }

  async adapterForDirectory(directory: string): Promise<OpenCodeAdapter> {
    this.#assertOpen();
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await this.#canonicalize(directory);
    } catch {
      throw new EngineUnavailableError(
        "the board checkout is unavailable and no engine can be assigned"
      );
    }
    this.#aliases.set(directory, canonicalDirectory);
    this.#assertOpen();

    const current = this.#entries.get(canonicalDirectory);
    if (current) {
      try {
        await current.manager.assertReady(this.#expectedVersion);
        this.#assertOpen();
      } catch (error) {
        current.protectedUntil = this.#now() + 30_000;
        throw error instanceof EngineUnavailableError
          ? error
          : new EngineUnavailableError(
              "the worktree engine is restarting or failed its health check"
            );
      }
      current.lastUsedAt = this.#now();
      if (current.activeSessions.size === 0) {
        current.protectedUntil = this.#now() + 30_000;
      }
      return current.adapter;
    }

    let pending = this.#pending.get(canonicalDirectory);
    if (!pending) {
      pending = this.#allocate(canonicalDirectory);
      this.#pending.set(canonicalDirectory, pending);
      pending
        .finally(() => {
          if (this.#pending.get(canonicalDirectory) === pending) {
            this.#pending.delete(canonicalDirectory);
          }
        })
        .catch(() => undefined);
    }
    const entry = await pending;
    this.#aliases.set(directory, entry.directory);
    entry.lastUsedAt = this.#now();
    return entry.adapter;
  }

  markSubscribed(directory: string, subscribed: boolean): void {
    const entry = this.#entryFor(directory);
    if (!entry) {
      return;
    }
    entry.protectedUntil = subscribed
      ? Math.max(entry.protectedUntil, this.#now() + 30_000)
      : Math.min(entry.protectedUntil, this.#now());
  }

  markReconciled(directory: string): void {
    const entry = this.#entryFor(directory);
    if (entry) {
      entry.reconciled = true;
      if (entry.activeSessions.size === 0) {
        entry.protectedUntil = this.#now() + 30_000;
      }
    }
  }

  markSessionActivity(
    directory: string,
    sessionId: string,
    active: boolean
  ): void {
    const entry = this.#entryFor(directory);
    if (!entry) {
      return;
    }
    if (active) {
      entry.activeSessions.add(sessionId);
      entry.protectedUntil = 0;
    } else {
      entry.activeSessions.delete(sessionId);
      if (entry.activeSessions.size === 0) {
        entry.protectedUntil = this.#now() + 30_000;
      }
    }
    entry.lastUsedAt = this.#now();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const pending = [...this.#pending.values()];
    await Promise.allSettled(
      [...this.#managers].map((manager) => manager.stop())
    );
    await Promise.allSettled(pending);
    this.#entries.clear();
    this.#pending.clear();
    this.#aliases.clear();
    this.#managers.clear();
  }

  async forceKill(): Promise<void> {
    this.#stopped = true;
    const managers = [...this.#managers];
    this.#entries.clear();
    this.#pending.clear();
    this.#aliases.clear();
    await Promise.allSettled(
      managers.map((manager) =>
        manager.forceKill ? manager.forceKill() : manager.stop()
      )
    );
  }

  #assertOpen(): void {
    if (this.#stopped) {
      throw new EngineUnavailableError("the engine pool is shutting down");
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  #entryFor(directory: string): EngineEntry | undefined {
    const key = this.#aliases.get(directory) ?? directory;
    return this.#entries.get(key);
  }

  async #allocate(directory: string): Promise<EngineEntry> {
    const previous = this.#allocationTail;
    let release: () => void = () => undefined;
    this.#allocationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      this.#assertOpen();
      const existing = this.#entries.get(directory);
      if (existing) {
        return existing;
      }
      if (this.#entries.size >= this.#maxEngines) {
        await this.#evictIdleEntry();
      }
      return await this.#startEntry(directory);
    } finally {
      release();
    }
  }

  async #evictIdleEntry(): Promise<void> {
    const now = this.#now();
    const candidate = [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.activeSessions.size === 0 &&
          entry.reconciled &&
          entry.protectedUntil <= now
      )
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!candidate) {
      throw new EngineUnavailableError(
        `the per-worktree engine pool is full (${String(this.#maxEngines)} active or reserved checkouts)`
      );
    }

    this.#evictionHandler?.(candidate.directory);
    await candidate.manager.stop();
    this.#managers.delete(candidate.manager);
    this.#entries.delete(candidate.directory);
    for (const [alias, canonical] of this.#aliases) {
      if (canonical === candidate.directory) {
        this.#aliases.delete(alias);
      }
    }
    logger.info("worktree-engine-released", {
      directory: candidate.directory,
      remaining: this.#entries.size,
    });
  }

  async #startEntry(directory: string): Promise<EngineEntry> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
      const port = await this.#allocatePort();
      this.#assertOpen();
      const baseUrl = `http://127.0.0.1:${String(port)}`;
      const manager = this.#managerFactory({
        adoptExisting: false,
        baseUrl,
        directory,
        expectedVersion: this.#expectedVersion,
        password: this.#password,
        port,
        readinessTimeoutMs: ENGINE_START_TIMEOUT_MS,
        username: this.#username,
      });
      this.#managers.add(manager);
      try {
        await manager.start();
        this.#assertOpen();
        await manager.assertReady(this.#expectedVersion);
        this.#assertOpen();
        const entry: EngineEntry = {
          adapter: this.#adapterFactory(
            baseUrl,
            directory,
            this.#username && this.#password
              ? { password: this.#password, username: this.#username }
              : undefined
          ),
          activeSessions: new Set(),
          directory,
          lastUsedAt: this.#now(),
          manager,
          // Protect a newly allocated engine until its event stream is either
          // established or explicitly abandoned by the bridge.
          protectedUntil: this.#now() + 30_000,
          reconciled: false,
        };
        this.#entries.set(directory, entry);
        logger.info("worktree-engine-ready", {
          directory,
          port,
          poolSize: this.#entries.size,
        });
        return entry;
      } catch (error) {
        lastError = error;
        await manager.stop().catch(() => undefined);
        this.#managers.delete(manager);
        this.#assertOpen();
      }
    }
    logger.error("worktree-engine-start-failed", {
      directory,
      attempts: PORT_ALLOCATION_ATTEMPTS,
      errorName: lastError instanceof Error ? lastError.name : "unknown",
    });
    throw new EngineUnavailableError(
      "a verified OpenCode engine could not be started for this checkout"
    );
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolvePromise) =>
      server.close(() => resolvePromise())
    );
    throw new EngineUnavailableError("an engine port could not be reserved");
  }
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}
