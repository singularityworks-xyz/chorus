import { describe, expect, test } from "bun:test";
import {
  assertSafePushEndpoint,
  isPublicAddress,
  pushSubscriptionInputSchema,
} from "./subscriptions";

const validInput = {
  endpoint: "https://fcm.googleapis.com/fcm/send/token",
  keys: {
    auth: Buffer.alloc(16, 1).toString("base64url"),
    p256dh: Buffer.alloc(65, 4).toString("base64url"),
  },
};

describe("push subscription policy", () => {
  test("validates bounded HTTPS subscription payloads and key lengths", () => {
    expect(pushSubscriptionInputSchema.safeParse(validInput).success).toBe(
      true
    );
    expect(
      pushSubscriptionInputSchema.safeParse({
        ...validInput,
        endpoint: "http://fcm.googleapis.com/token",
      }).success
    ).toBe(false);
    expect(
      pushSubscriptionInputSchema.safeParse({
        ...validInput,
        keys: { ...validInput.keys, p256dh: "AQ" },
      }).success
    ).toBe(false);
    expect(
      pushSubscriptionInputSchema.safeParse({
        ...validInput,
        unexpected: true,
      }).success
    ).toBe(false);
  });

  test("allows an approved provider only after public DNS validation", async () => {
    const endpoint = await assertSafePushEndpoint(validInput.endpoint, {
      lookupHost: async () => [{ address: "142.250.72.106" }],
    });
    expect(endpoint.hostname).toBe("fcm.googleapis.com");
  });

  test("rejects unsupported providers, credentials, redirects, and private DNS", async () => {
    await expect(
      assertSafePushEndpoint("https://attacker.example/push", {
        lookupHost: async () => [{ address: "8.8.8.8" }],
      })
    ).rejects.toThrow("host is not allowed");
    await expect(
      assertSafePushEndpoint("https://user:pass@fcm.googleapis.com/push", {
        lookupHost: async () => [{ address: "142.250.72.106" }],
      })
    ).rejects.toThrow("HTTPS destination");
    await expect(
      assertSafePushEndpoint(validInput.endpoint, {
        lookupHost: async () => [
          { address: "142.250.72.106" },
          { address: "127.0.0.1" },
        ],
      })
    ).rejects.toThrow("non-public");
    await expect(
      assertSafePushEndpoint("https://fcm.googleapis.com:8443/push", {
        lookupHost: async () => [{ address: "142.250.72.106" }],
      })
    ).rejects.toThrow("HTTPS destination");
  });

  test("classifies private, link-local, and invalid IPs as non-public", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.1.1",
      "172.20.0.1",
      "192.168.1.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
