import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { OpenCodeProcessManager } from "./process-manager";

const INVALID_PORT_MESSAGE = /OPENCODE_PORT/;

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

  test("defaults the port and the base url to the same place", () => {
    unset("OPENCODE_PORT");
    unset("OPENCODE_BASE_URL");

    const config = loadConfig();

    expect(config.opencodePort).toBe(4096);
    expect(config.opencodeBaseUrl).toBe(
      `http://localhost:${String(config.opencodePort)}`
    );
  });

  test("OPENCODE_PORT moves both together", () => {
    unset("OPENCODE_BASE_URL");
    process.env.OPENCODE_PORT = "4999";

    const config = loadConfig();

    expect(config.opencodePort).toBe(4999);
    expect(config.opencodeBaseUrl).toBe("http://localhost:4999");
  });

  test("an explicit base url still wins, for a remote engine", () => {
    process.env.OPENCODE_PORT = "4999";
    process.env.OPENCODE_BASE_URL = "http://opencode.internal:1234";

    const config = loadConfig();

    expect(config.opencodeBaseUrl).toBe("http://opencode.internal:1234");
    // The port is what we would spawn on; a remote engine means we spawn nothing.
    expect(config.opencodePort).toBe(4999);
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
      const port = 45_997;
      const server = Bun.serve({
        fetch: () => Response.json({ healthy: true, version: "1.18.29" }),
        port,
      });

      try {
        const manager = new OpenCodeProcessManager({
          directory: "/tmp",
          port,
        });
        await manager.start();

        // Not ours: serve adopted it, so a failed probe must never kill it.
        expect(manager.observedVersion).toBe("1.18.29");
        await manager.stop();
      } finally {
        server.stop(true);
      }
    });

    test("an unresponsive engine is reported rather than assumed healthy", async () => {
      const port = 45_998;
      // A responder that is up but reports itself unhealthy — the shape of a
      // wedged engine, as distinct from nothing listening.
      const server = Bun.serve({
        fetch: () => Response.json({ healthy: false }),
        port,
      });

      try {
        const manager = new OpenCodeProcessManager({
          directory: "/tmp",
          port,
        });
        await manager.start();

        // Adopted, so no restart was attempted, but nothing healthy was reported
        // either. Startup completes rather than hanging on a doomed engine.
        expect(manager.observedVersion).toBeNull();
        await manager.stop();
      } finally {
        server.stop(true);
      }
    });
  });
});
