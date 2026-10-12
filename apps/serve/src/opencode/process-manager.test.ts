import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { loadConfig } from "../config";
import {
  EngineUnavailableError,
  OpenCodeProcessManager,
  resolveOpenCodeBinary,
} from "./process-manager";

const INVALID_PORT_MESSAGE = /OPENCODE_PORT/;
const REMOTE_AUTOSTART_MESSAGE = /cannot be used with a remote/;
const AUTH_PAIR_MESSAGE = /must be configured together/;
const UNHEALTHY_ENGINE_MESSAGE = /reports an unhealthy state/;
const SDK_VERSION_MISMATCH_MESSAGE = /does not match the required SDK version/;

/**
 * The engine address has to come from one place.
 *
 * The process manager used to hardcode 4096 while `opencodeBaseUrl` defaulted to
 * `http://localhost:4096` independently. Setting either one alone left serve
 * spawning on a port it then never talked to, or talking to a port nothing
 * listens on — and the failure surfaced as an agent prompt that silently did
 * nothing.
 */
describe("opencode engine address", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  /** `loadConfig` reads env directly, so an "unset" var has to actually be absent. */
  function unset(name: string): void {
    Reflect.deleteProperty(process.env, name);
  }

  test("resolves the pinned local CLI binary instead of PATH", () => {
    const binary = resolveOpenCodeBinary();
    expect(binary).toContain("opencode-ai");
    expect(existsSync(binary)).toBe(true);
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
    /**
     * The engine has to answer on identity, not merely occupy the port. An engine
     * that wedges — alive as a process, no longer replying — is otherwise
     * indistinguishable from a slow model, and every prompt after it hangs with
     * nothing in any log.
     */
    test("an adopted engine is never probed into a restart", async () => {
      // Port 0 lets the OS assign one. A fixed port collides when bun runs test
      // files in parallel, which shows up as an unrelated EADDRINUSE.
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

        // Not ours: serve adopted it, so a failed probe must never kill it.
        expect(manager.observedVersion).toBe("1.19.0");
        await manager.stop();
      } finally {
        server.stop(true);
      }
    });

    test("an unhealthy endpoint is not adopted as a working engine", async () => {
      // A responder that is up but reports itself unhealthy — the shape of a
      // wedged engine, as distinct from nothing listening.
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
