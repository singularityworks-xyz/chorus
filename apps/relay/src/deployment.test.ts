import { describe, expect, test } from "bun:test";
import { renderRelayDeployment } from "./deployment";
import { testConfig } from "./testing/config";

describe("central relay isolation", () => {
  test("keeps backend listeners private and authorizes every tunnel operation", () => {
    const result = renderRelayDeployment(testConfig());
    expect(Bun.TOML.parse(result.frps)).toMatchObject({
      bindAddr: "127.0.0.1",
      proxyBindAddr: "127.0.0.1",
      auth: { method: "oidc" },
      httpPlugins: [
        {
          addr: "127.0.0.1:8082",
          ops: [
            "Login",
            "NewProxy",
            "Ping",
            "NewWorkConn",
            "NewUserConn",
            "CloseProxy",
          ],
        },
      ],
    });
    expect(result.caddy).not.toContain("hosts.example.net");
    expect(result.haproxy).toContain("server encrypted_hosts 127.0.0.1:7443");
    expect(result.haproxy).not.toContain("ssl crt");
    expect(result.caddy).toContain("header_up X-Real-IP {remote_host}");
    expect(result.caddy).toContain("fallback_policy require");
  });

  test("rejects control names in the user-controlled host namespace", () => {
    expect(() =>
      renderRelayDeployment({
        ...testConfig(),
        tunnelOrigin: "https://connect.hosts.example.net",
      })
    ).toThrow();
    expect(() =>
      renderRelayDeployment({
        ...testConfig(),
        tunnelOrigin: testConfig().accountOrigin,
      })
    ).toThrow();
  });
});
