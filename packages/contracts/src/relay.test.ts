import { describe, expect, test } from "bun:test";
import { relayOperatorConfigSchema, validateRelayConnection } from "./relay";

const operator = {
  accountOrigin: "https://accounts.example.com",
  tunnelOrigin: "https://connect.example.com",
  hostsDomain: "hosts.example.net",
};
const hostId = crypto.randomUUID();
const connection = {
  audience: `${operator.accountOrigin}/tunnel`,
  clientId: "test-client",
  clientSecret: "test-credential",
  hostId,
  hostname: `h-${hostId.replaceAll("-", "")}.${operator.hostsDomain}`,
  issuer: `${operator.accountOrigin}/api/auth`,
  serverUrl: operator.tunnelOrigin,
  tokenEndpoint: `${operator.accountOrigin}/api/auth/oauth2/token`,
};

describe("pinned relay connection", () => {
  test("normalizes the configured origins and refuses injected hosts, issuers, or endpoints", () => {
    expect(
      relayOperatorConfigSchema.parse({
        ...operator,
        accountOrigin: `${operator.accountOrigin}/`,
      })
    ).toEqual(operator);
    expect(validateRelayConnection(connection, operator, hostId)).toEqual(
      connection
    );
    for (const override of [
      { hostId: crypto.randomUUID() },
      { serverUrl: "https://other.example.com" },
      { hostname: "other.hosts.example.net" },
      { audience: "https://other.example.com/tunnel" },
      { tokenEndpoint: "https://other.example.com/token" },
      { issuer: "https://other.example.com" },
    ]) {
      expect(() =>
        validateRelayConnection(
          { ...connection, ...override },
          operator,
          hostId
        )
      ).toThrow();
    }
  });
});
