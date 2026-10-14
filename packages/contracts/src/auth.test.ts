import { describe, expect, test } from "bun:test";
import {
  devicePairingTokenResponseSchema,
  webSocketTicketResponseSchema,
} from "./auth";

describe("WebSocket ticket response", () => {
  test("accepts a generated 16-byte hex ticket", () => {
    expect(
      webSocketTicketResponseSchema.safeParse({ ticket: "a1".repeat(16) })
        .success
    ).toBe(true);
  });

  test("rejects missing, malformed, and oversized tickets", () => {
    for (const value of [
      {},
      { ticket: "" },
      { ticket: "g1".repeat(16) },
      { ticket: "a1".repeat(15) },
      { ticket: "a1".repeat(17) },
    ]) {
      expect(webSocketTicketResponseSchema.safeParse(value).success).toBe(
        false
      );
    }
  });
});

describe("device pairing token response", () => {
  test("accepts a 256-bit hex code with an expiry", () => {
    expect(
      devicePairingTokenResponseSchema.safeParse({
        expiresAt: Date.now() + 300_000,
        token: "a1".repeat(32),
      }).success
    ).toBe(true);
  });

  test("rejects malformed codes and invalid expirations", () => {
    for (const value of [
      {},
      { expiresAt: Date.now() + 300_000, token: "bad" },
      { expiresAt: Number.POSITIVE_INFINITY, token: "a1".repeat(32) },
      { expiresAt: 0, token: "a1".repeat(32) },
    ]) {
      expect(devicePairingTokenResponseSchema.safeParse(value).success).toBe(
        false
      );
    }
  });
});
