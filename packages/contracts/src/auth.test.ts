import { describe, expect, test } from "bun:test";
import { webSocketTicketResponseSchema } from "./auth";

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
