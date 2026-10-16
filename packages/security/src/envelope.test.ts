import { describe, expect, test } from "bun:test";
import { SecretEnvelope } from ".";

const secret = "test-only-secret-with-more-than-32-bytes";

describe("encrypted local storage", () => {
  test("uses separate nonces and binds ciphertext to its context and purpose", () => {
    const envelope = new SecretEnvelope(secret, "enrollment");
    const first = envelope.seal("one", "machine-credential");
    expect(first).not.toContain("machine-credential");
    expect(first).not.toBe(envelope.seal("one", "machine-credential"));
    expect(envelope.open("one", first)).toBe("machine-credential");
    expect(() => envelope.open("two", first)).toThrow();
    expect(() =>
      new SecretEnvelope(secret, "host").open("one", first)
    ).toThrow();
    expect(() =>
      new SecretEnvelope(`${secret}-different`, "enrollment").open("one", first)
    ).toThrow();
    expect(() => envelope.open("one", first.slice(0, -5))).toThrow();
  });

  test("rejects missing key material and malformed envelopes", () => {
    expect(() => new SecretEnvelope("short", "host")).toThrow();
    const envelope = new SecretEnvelope(secret, "host");
    for (const value of ["", "!invalid!", "a", "A".repeat(70_000)]) {
      expect(() => envelope.open("one", value)).toThrow();
    }
    expect(envelope.open("empty", envelope.seal("empty", ""))).toBe("");
  });
});
