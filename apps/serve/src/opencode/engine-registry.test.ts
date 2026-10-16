import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type EngineManagerInput,
  EngineRegistry,
  type ManagedEngine,
} from "./engine-registry";
import { EngineUnavailableError } from "./process-manager";

const temporaryDirectories: string[] = [];
const fixtureRoot = resolve(import.meta.dir, "../../../../");

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(fixtureRoot, ".tmp-engine-pool-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHarness({
  limit = 8,
  now = () => Date.now(),
}: {
  limit?: number;
  now?: () => number;
} = {}) {
  let nextPort = 45_000;
  const managers: Array<{
    input: EngineManagerInput;
    manager: ManagedEngine;
  }> = [];
  const registry = new EngineRegistry({
    allocatePort: () => {
      nextPort += 1;
      return Promise.resolve(nextPort);
    },
    expectedVersion: "1.19.0",
    maxEngines: limit,
    now,
    managerFactory: (input) => {
      const manager: ManagedEngine = {
        assertReady: mock(async () => undefined),
        start: mock(async () => undefined),
        stop: mock(async () => undefined),
      };
      managers.push({ input, manager });
      return manager;
    },
  });
  return { managers, registry };
}

describe("EngineRegistry", () => {
  test("shutdown cancels startup and queued allocations without leaking an engine", async () => {
    let releaseStartup: () => void = () => undefined;
    let notifyStarted: () => void = () => undefined;
    const startup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const manager: ManagedEngine = {
      assertReady: mock(async () => undefined),
      start: mock(() => {
        notifyStarted();
        return startup;
      }),
      stop: mock(() => {
        releaseStartup();
        return Promise.resolve();
      }),
    };
    const managerFactory = mock(() => manager);
    const registry = new EngineRegistry({
      allocatePort: async () => 45_000,
      canonicalize: async (directory) => directory,
      expectedVersion: "1.19.0",
      managerFactory,
    });
    const first = registry.adapterForDirectory("/first");
    const second = registry.adapterForDirectory("/second");
    const results = Promise.allSettled([first, second]);
    await started;
    await registry.stop();
    expect((await results).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(managerFactory).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalled();
    expect(manager.assertReady).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
    await expect(registry.adapterForDirectory("/third")).rejects.toBeInstanceOf(
      EngineUnavailableError
    );
  });

  test("shares one in-flight startup for canonical directory aliases", async () => {
    const directory = fixtureDirectory();
    const alias = join(directory, ".");
    const { managers, registry } = createHarness();
    try {
      const [first, second] = await Promise.all([
        registry.adapterForDirectory(directory),
        registry.adapterForDirectory(alias),
      ]);

      expect(first).toBe(second);
      expect(managers).toHaveLength(1);
      expect(managers[0]?.manager.start).toHaveBeenCalledTimes(1);
      expect(managers[0]?.manager.assertReady).toHaveBeenCalledWith("1.19.0");
      expect(managers[0]?.input.port).toBe(45_001);
      expect(registry.size).toBe(1);
    } finally {
      await registry.stop();
    }
  });

  test("refuses a ninth busy checkout instead of silently sharing an engine", async () => {
    const firstDirectory = fixtureDirectory();
    const secondDirectory = fixtureDirectory();
    const { registry } = createHarness({ limit: 1 });
    try {
      await registry.adapterForDirectory(firstDirectory);
      registry.markSessionActivity(firstDirectory, "session-1", true);
      registry.markReconciled(firstDirectory);
      registry.markSubscribed(firstDirectory, true);

      await expect(
        registry.adapterForDirectory(secondDirectory)
      ).rejects.toBeInstanceOf(EngineUnavailableError);
      expect(registry.size).toBe(1);
    } finally {
      await registry.stop();
    }
  });

  test("releases the least recently used reconciled idle engine", async () => {
    const firstDirectory = fixtureDirectory();
    const secondDirectory = fixtureDirectory();
    let currentTime = 1000;
    const { managers, registry } = createHarness({
      limit: 1,
      now: () => currentTime,
    });
    const evicted: string[] = [];
    registry.setEvictionHandler((directory) => evicted.push(directory));
    try {
      await registry.adapterForDirectory(firstDirectory);
      registry.markReconciled(firstDirectory);
      registry.markSubscribed(firstDirectory, true);
      currentTime += 31_000;

      await registry.adapterForDirectory(secondDirectory);

      expect(managers[0]?.manager.stop).toHaveBeenCalledTimes(1);
      expect(evicted).toHaveLength(1);
      expect(registry.size).toBe(1);
      expect(managers[1]?.input.directory).toBe(secondDirectory);
    } finally {
      await registry.stop();
    }
  });

  test("starts one engine per canonical directory with distinct allocated ports", async () => {
    const firstDirectory = fixtureDirectory();
    const secondDirectory = fixtureDirectory();
    const { managers, registry } = createHarness();
    try {
      await Promise.all([
        registry.adapterForDirectory(firstDirectory),
        registry.adapterForDirectory(secondDirectory),
      ]);

      expect(new Set(managers.map(({ input }) => input.port)).size).toBe(2);
      expect(managers.map(({ input }) => input.adoptExisting)).toEqual([
        false,
        false,
      ]);
      expect(managers.map(({ input }) => input.baseUrl)).toEqual(
        managers.map(({ input }) => `http://127.0.0.1:${input.port}`)
      );
      expect(registry.size).toBe(2);
    } finally {
      await registry.stop();
    }
  });
});
