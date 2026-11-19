import { describe, expect, test } from "bun:test";
import { resolveSocketUrl } from "./socket-url";

describe("resolveSocketUrl", () => {
  test("uses the page origin and secure scheme by default", () => {
    expect(
      resolveSocketUrl({ isSecure: false, origin: "http://localhost:2000" })
    ).toBe("ws://localhost:2000/ws");
    expect(
      resolveSocketUrl({ isSecure: true, origin: "https://chorus.example" })
    ).toBe("wss://chorus.example/ws");
  });

  test("uses a local Serve port for loopback development origins", () => {
    expect(
      resolveSocketUrl({
        localServePort: 2000,
        isSecure: false,
        origin: "http://localhost:3000",
      })
    ).toBe("ws://localhost:2000/ws");
    expect(
      resolveSocketUrl({
        localServePort: 2000,
        isSecure: true,
        origin: "https://host.example:3000",
      })
    ).toBe("wss://host.example:3000/ws");
  });

  test("uses the configured development port for directly served Next apps", () => {
    expect(
      resolveSocketUrl({
        developmentServePort: 2000,
        isSecure: false,
        origin: "http://localhost:3000",
      })
    ).toBe("ws://localhost:2000/ws");
  });

  test("treats empty or whitespace overrides as unset", () => {
    expect(
      resolveSocketUrl({
        explicit: "  ",
        isSecure: false,
        origin: "http://app.test",
      })
    ).toBe("ws://app.test/ws");
  });

  test("uses an explicit address scheme and replaces its path and query", () => {
    expect(
      resolveSocketUrl({
        explicit: "https://serve.example/some/path?ticket=old",
        isSecure: false,
        origin: "http://app.test",
      })
    ).toBe("wss://serve.example/ws");
    expect(
      resolveSocketUrl({
        explicit: "ws://serve.example:9000",
        isSecure: true,
        origin: "https://app.test",
      })
    ).toBe("ws://serve.example:9000/ws");
  });

  test("rebinds configured loopback hosts for a LAN browser only when enabled", () => {
    expect(
      resolveSocketUrl({
        allowLocalHostRebinding: true,
        explicit: "http://localhost:2000",
        isSecure: false,
        origin: "http://192.168.1.8:3000",
      })
    ).toBe("ws://192.168.1.8:2000/ws");
    expect(
      resolveSocketUrl({
        explicit: "http://localhost:2000",
        isSecure: false,
        origin: "http://192.168.1.8:3000",
      })
    ).toBe("ws://localhost:2000/ws");
  });
});
