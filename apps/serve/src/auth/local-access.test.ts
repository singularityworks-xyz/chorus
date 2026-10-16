import { describe, expect, test } from "bun:test";
import { canCreateLocalSession, isLoopbackAddress } from "./local-access";

describe("local session access", () => {
  test("recognizes only direct IPv4 and IPv6 loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.255.255.255")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.4")).toBe(false);
    expect(isLoopbackAddress("unknown")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });

  test("requires development mode, a direct loopback peer, an allowed origin, and the request marker", () => {
    const valid = {
      isProduction: false,
      localOrigins: ["http://localhost:3000"],
      origin: "http://localhost:3000",
      peerAddress: "127.0.0.1",
      requestMarker: "1",
    };

    expect(canCreateLocalSession(valid)).toBe(true);
    expect(canCreateLocalSession({ ...valid, isProduction: true })).toBe(false);
    expect(
      canCreateLocalSession({ ...valid, peerAddress: "192.168.1.4" })
    ).toBe(false);
    expect(
      canCreateLocalSession({ ...valid, origin: "http://evil.test" })
    ).toBe(false);
    expect(canCreateLocalSession({ ...valid, requestMarker: null })).toBe(
      false
    );
  });
});
