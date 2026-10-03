import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config";

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
});
