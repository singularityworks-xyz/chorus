import { describe, expect, test } from "bun:test";
import { loadRelayConfig } from "./config";
import { testEnvironment } from "./testing/config";

describe("relay configuration", () => {
  test("requires secure isolated origins and bounded launch capacity", () => {
    expect(loadRelayConfig(testEnvironment).maxOnlineHosts).toBe(100);
    for (const override of [
      { RELAY_ACCOUNT_ORIGIN: "http://accounts.example.com" },
      { RELAY_ACCOUNT_ORIGIN: "https://accounts.example.com/path" },
      { RELAY_ACCOUNT_ORIGIN: "https://other.hosts.example.net" },
      { RELAY_HOSTS_DOMAIN: "*.example.net" },
      { RELAY_MAX_ONLINE_HOSTS: "10001" },
      { RELAY_MAX_HOSTS_PER_ACCOUNT: "0" },
    ]) {
      expect(() =>
        loadRelayConfig({ ...testEnvironment, ...override })
      ).toThrow();
    }
  });

  test("configuration errors never echo credential values", () => {
    try {
      loadRelayConfig({
        ...testEnvironment,
        RELAY_DATABASE_URL: "invalid-private-value",
      });
      throw new Error("configuration unexpectedly accepted");
    } catch (error) {
      expect(String(error)).toContain("databaseUrl");
      expect(String(error)).not.toContain("invalid-private-value");
    }
  });
});
