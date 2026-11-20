import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../config";
import { EngineUnavailableError } from "./errors";
import { OpenCodeProcessManager } from "./manager";
import { createOpenCodeEnvironment, resolveOpenCodeBinary } from "./runtime";

const INVALID_PORT_MESSAGE = /OPENCODE_PORT/;
const REMOTE_AUTOSTART_MESSAGE = /cannot be used with a remote/;
const AUTH_PAIR_MESSAGE = /must be configured together/;
const UNHEALTHY_ENGINE_MESSAGE = /reports an unhealthy state/;
const SDK_VERSION_MISMATCH_MESSAGE = /does not match the required SDK version/;

describe("opencode engine address", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  function unset(name: string): void {
    Reflect.deleteProperty(process.env, name);
  }

  test("resolves the pinned local CLI binary instead of PATH", () => {
    const binary = resolveOpenCodeBinary();
    expect(binary).toContain("opencode-ai");
    expect(existsSync(binary)).toBe(true);
  });

  test("isolates managed OpenCode storage and preserves other environment values", () => {
    const environment = createOpenCodeEnvironment("/chorus/opencode.db", {
      OPENAI_API_KEY: "test-key",
      OPENCODE_DB: "/operator/opencode.db",
    });

    expect(environment).toEqual({
      OPENAI_API_KEY: "test-key",
      OPENCODE_DB: "/chorus/opencode.db",
    });
  });

  test("defaults the port and the base url to the same place", () => {
    unset("OPENCODE_PORT");
    unset("OPENCODE_BASE_URL");

    const config = loadConfig();

    expect(config.opencodePort).toBe(4096);
    expect(config.opencodeBaseUrl).toBe(
      `http://127.0.0.1:${String(config.opencodePort)}`
    );
  });

  test("OPENCODE_PORT moves both together", () => {
    unset("OPENCODE_BASE_URL");
    process.env.OPENCODE_PORT = "4999";

    const config = loadConfig();

    expect(config.opencodePort).toBe(4999);
    expect(config.opencodeBaseUrl).toBe("http://127.0.0.1:4999");
  });

  test("a remote base url disables local engine startup by default", () => {
    process.env.OPENCODE_PORT = "4999";
    process.env.OPENCODE_BASE_URL = "http://opencode.internal:1234";

    const config = loadConfig();

    expect(config.opencodeBaseUrl).toBe("http://opencode.internal:1234");
    expect(config.opencodePort).toBe(4999);
    expect(config.autoStartOpencode).toBe(false);
  });

  test("rejects an explicit request to start a local child for a remote URL", () => {
    process.env.OPENCODE_BASE_URL = "https://opencode.internal";
    process.env.OPENCODE_AUTO_START = "true";
    expect(() => loadConfig()).toThrow(REMOTE_AUTOSTART_MESSAGE);
  });

  test("requires the engine username and password together", () => {
    process.env.OPENCODE_USERNAME = "chorus";
    Reflect.deleteProperty(process.env, "OPENCODE_PASSWORD");
    expect(() => loadConfig()).toThrow(AUTH_PAIR_MESSAGE);
  });

  test("a nonsense port is rejected rather than silently defaulted", () => {
    process.env.OPENCODE_PORT = "not-a-port";
    expect(() => loadConfig()).toThrow(INVALID_PORT_MESSAGE);
  });

  describe("liveness", () => {
    test("an adopted engine is never probed into a restart", async () => {
      const server = Bun.serve({
        fetch: () => Response.json({ healthy: true, version: "1.19.0" }),
        hostname: "127.0.0.1",
        port: 0,
      });
      const port = server.port;

      try {
        const manager = new OpenCodeProcessManager({
          directory: "/tmp",
          port,
        });
        await manager.start();

        expect(manager.observedVersion).toBe("1.19.0");
        await manager.stop();
      } finally {
        server.stop(true);
      }
    });

    test("restarts an owned engine after an unexpected child exit", async () => {
      const directory = mkdtempSync(join(tmpdir(), "chorus-engine-restart-"));
      const pidFile = join(directory, "engine-instance.txt");
      const reservation = Bun.serve({
        fetch: () => new Response(),
        hostname: "127.0.0.1",
        port: 0,
      });
      const port = reservation.port;
      reservation.stop(true);
      let spawnCount = 0;
      const manager = new OpenCodeProcessManager({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        directory,
        expectedVersion: "1.19.0",
        maxRestarts: 1,
        port,
        readinessTimeoutMs: 3000,
        spawnEngine: (port, hostname) => {
          spawnCount += 1;
          const fixture = `
            import { writeFileSync } from "node:fs";
            const server = Bun.serve({
              fetch: () => Response.json({ healthy: true, version: "1.19.0" }),
              hostname: ${JSON.stringify(hostname)},
              port: ${String(port)},
            });
            writeFileSync(${JSON.stringify(pidFile)}, "${String(spawnCount)}:" + String(process.pid));
            setInterval(() => {}, 60_000);
            void server;
          `;
          return Bun.spawn([process.execPath, "-e", fixture], {
            cwd: directory,
            stdin: "ignore",
            stderr: "pipe",
            stdout: "pipe",
            windowsHide: true,
          });
        },
      });

      try {
        await manager.start();
        const initial = readFileSync(pidFile, "utf8").split(":");
        const initialGeneration = Number(initial[0]);
        const initialPid = Number(initial[1]);
        expect(initialGeneration).toBe(1);
        expect(Number.isInteger(initialPid)).toBe(true);

        process.kill(initialPid, "SIGKILL");

        const deadline = Date.now() + 10_000;
        let restartedGeneration = 0;
        while (Date.now() < deadline) {
          const current = readFileSync(pidFile, "utf8").split(":");
          restartedGeneration = Number(current[0]);
          if (restartedGeneration > initialGeneration && manager.ready) {
            break;
          }
          await Bun.sleep(25);
        }

        expect(restartedGeneration).toBe(2);
        expect(spawnCount).toBe(2);
        await manager.assertReady("1.19.0");
        expect(manager.ready).toBe(true);
      } finally {
        await manager.stop();
        rmSync(directory, { force: true, recursive: true });
      }
    });

    test("beginShutdown immediately marks an adopted engine unavailable", async () => {
      const server = Bun.serve({
        fetch: () => Response.json({ healthy: true, version: "1.19.0" }),
        hostname: "127.0.0.1",
        port: 0,
      });
      const manager = new OpenCodeProcessManager({
        directory: "/tmp",
        port: server.port,
      });

      try {
        await manager.start();
        expect(manager.ready).toBe(true);

        manager.beginShutdown();

        expect(manager.ready).toBe(false);
        await manager.stop();
        expect(
          (await fetch(`http://127.0.0.1:${String(server.port)}/global/health`))
            .ok
        ).toBe(true);
      } finally {
        server.stop(true);
      }
    });

    test("an unhealthy endpoint is not adopted as a working engine", async () => {
      const server = Bun.serve({
        fetch: () => Response.json({ healthy: false }),
        hostname: "127.0.0.1",
        port: 0,
      });
      const port = server.port;

      try {
        const manager = new OpenCodeProcessManager({
          directory: "/tmp",
          port,
        });
        await expect(manager.start()).rejects.toThrow(UNHEALTHY_ENGINE_MESSAGE);
      } finally {
        server.stop(true);
      }
    });

    test("health probes carry configured Basic authentication", async () => {
      const observed: { authorization?: string | null } = {};
      const server = Bun.serve({
        fetch: (request) => {
          observed.authorization = request.headers.get("authorization");
          return Response.json({ healthy: true, version: "1.19.0" });
        },
        hostname: "127.0.0.1",
        port: 0,
      });

      try {
        const manager = new OpenCodeProcessManager({
          baseUrl: `http://127.0.0.1:${String(server.port)}`,
          directory: process.cwd(),
          password: "secret-value",
          username: "service",
        });
        expect(await manager.probeVersion()).toBe("1.19.0");
        expect(observed.authorization).toBe(
          `Basic ${Buffer.from("service:secret-value").toString("base64")}`
        );
        await manager.stop();
      } finally {
        server.stop(true);
      }
    });

    test("work is rejected until a healthy matching engine is verified", async () => {
      let payload: unknown = { healthy: true, version: "1.19.0" };
      const server = Bun.serve({
        fetch: () => Response.json(payload),
        hostname: "127.0.0.1",
        port: 0,
      });
      const manager = new OpenCodeProcessManager({
        baseUrl: `http://127.0.0.1:${String(server.port)}`,
        directory: process.cwd(),
        expectedVersion: "1.19.0",
      });

      try {
        expect(manager.ready).toBe(false);
        await manager.assertReady();
        expect(manager.ready).toBe(true);

        payload = { healthy: true };
        await expect(manager.assertReady()).rejects.toBeInstanceOf(
          EngineUnavailableError
        );
        expect(manager.ready).toBe(false);

        payload = { healthy: true, version: "1.18.29" };
        await expect(manager.assertReady()).rejects.toThrow(
          SDK_VERSION_MISMATCH_MESSAGE
        );
      } finally {
        await manager.stop();
        server.stop(true);
      }
    });

    test("an adopted engine with an unknown or mismatched version is refused", async () => {
      for (const version of [undefined, "1.18.29"]) {
        const server = Bun.serve({
          fetch: () =>
            Response.json({
              healthy: true,
              ...(version ? { version } : {}),
            }),
          hostname: "127.0.0.1",
          port: 0,
        });
        const manager = new OpenCodeProcessManager({
          baseUrl: `http://127.0.0.1:${String(server.port)}`,
          directory: process.cwd(),
          expectedVersion: "1.19.0",
        });
        try {
          await expect(manager.start()).rejects.toBeInstanceOf(
            EngineUnavailableError
          );
          expect(manager.ready).toBe(false);
        } finally {
          await manager.stop();
          server.stop(true);
        }
      }
    });
  });
});
