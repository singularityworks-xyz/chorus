import { describe, expect, test } from "bun:test";
import { createTunnelConfig, trustedRelayAuthorities } from "./tunnel-config";

const connection = {
  audience: "https://accounts.example.com/tunnel",
  clientId: "test-machine",
  clientSecret: "test-credential",
  hostId: crypto.randomUUID(),
  hostname: "h-one.hosts.example.net",
  issuer: "https://accounts.example.com/api/auth",
  serverUrl: "https://connect.example.com",
  tokenEndpoint: "https://accounts.example.com/api/auth/oauth2/token",
};

describe("verified TLS tunnel configuration", () => {
  test("uses WSS, explicit root authorities, isolated routes, and loopback backends", () => {
    const text = createTunnelConfig(connection, {
      caFile: "C:\\private\\roots.pem",
      httpsPort: 2443,
      acmePort: 2080,
    });
    const parsed = Bun.TOML.parse(text);
    expect(parsed).toMatchObject({
      serverAddr: "connect.example.com",
      serverPort: 443,
      transport: {
        protocol: "wss",
        tls: {
          enable: true,
          serverName: "connect.example.com",
          trustedCaFile: "C:\\private\\roots.pem",
        },
      },
      auth: {
        method: "oidc",
        oidc: {
          clientID: connection.clientId,
          scope: "relay:connect",
          trustedCaFile: "C:\\private\\roots.pem",
          additionalEndpointParams: { resource: connection.audience },
        },
      },
      proxies: [
        {
          type: "https",
          localIP: "127.0.0.1",
          localPort: 2443,
          customDomains: [connection.hostname],
        },
        {
          type: "http",
          localIP: "127.0.0.1",
          localPort: 2080,
          locations: ["/.well-known/acme-challenge/"],
        },
      ],
    });
    expect(trustedRelayAuthorities()).toContain("BEGIN CERTIFICATE");
  });

  test("refuses insecure origins and invalid local ports", () => {
    expect(() =>
      createTunnelConfig(
        { ...connection, serverUrl: "http://connect.example.com" },
        { caFile: "/roots.pem", httpsPort: 2443, acmePort: 2080 }
      )
    ).toThrow();
    expect(() =>
      createTunnelConfig(connection, {
        caFile: "/roots.pem",
        httpsPort: 0,
        acmePort: 2080,
      })
    ).toThrow();
  });
});
