import { describe, expect, test } from "bun:test";
import { DEVICE_PAIRING_TTL_MS, DevicePairingTokenStore } from "./pairing";

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

describe("device pairing tokens", () => {
  test("issues a high-entropy token and consumes it once", async () => {
    const store = new DevicePairingTokenStore(() => 1_700_000_000_000);
    const issued = await store.issue();

    expect(issued.token).toMatch(TOKEN_SHAPE);
    expect(issued.expiresAt).toBe(1_700_000_000_000 + DEVICE_PAIRING_TTL_MS);
    expect(await store.consume(issued.token)).toBe(true);
    expect(await store.consume(issued.token)).toBe(false);
    expect(store.size).toBe(0);
  });

  test("rejects malformed, unknown, and expired tokens", async () => {
    let now = 1_700_000_000_000;
    const store = new DevicePairingTokenStore(() => now);
    const issued = await store.issue();

    expect(await store.consume("not-a-token")).toBe(false);
    expect(await store.consume("a".repeat(64))).toBe(false);

    now += DEVICE_PAIRING_TTL_MS;
    expect(await store.consume(issued.token)).toBe(false);
    expect(store.size).toBe(0);
  });

  test("a new code invalidates the previous code and replaces its digest", async () => {
    const store = new DevicePairingTokenStore(() => 1_700_000_000_000);
    const previous = await store.issue();
    const current = await store.issue();

    expect(store.size).toBe(1);
    expect(await store.consume(previous.token)).toBe(false);
    expect(await store.consume(current.token)).toBe(true);
    expect(store.size).toBe(0);
  });

  test("concurrent attempts can consume a code only once", async () => {
    const store = new DevicePairingTokenStore(() => 1_700_000_000_000);
    const issued = await store.issue();

    const results = await Promise.all([
      store.consume(issued.token),
      store.consume(issued.token),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.size).toBe(0);
  });
});
