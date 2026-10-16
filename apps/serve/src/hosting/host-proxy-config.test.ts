import { describe, expect, test } from "bun:test";
import { createHostProxyConfig } from "./host-proxy-config";

const options = {
  hostId: crypto.randomUUID(),
  hostname: "h-test.hosts.example.com",
  servePort: 2000,
  webPort: 3000,
  httpsPort: 2443,
  acmePort: 2080,
};

describe("user host TLS endpoint", () => {
  test("isolates listeners, local bootstrap, origins, certificates, and relay probes", () => {
    const text = createHostProxyConfig(options);
    expect(text).toContain("admin off");
    expect(text).toContain("default_bind 127.0.0.1");
    expect(text).toContain("http://h-test.hosts.example.com");
    expect(text).toContain("https://h-test.hosts.example.com");
    expect(text).toContain("strict_sni_host on");
    expect(text).toContain("respond @bootstrap 403");
    expect(text).toContain("respond @foreign_origin 403");
    expect(text).toContain("disable_tlsalpn_challenge");
    expect(text).toContain("handle /auth/relay-probe");
    expect(text).toContain("127.0.0.1:3000");
    expect(text).not.toContain("tls internal");
  });

  test("rejects configuration injection and conflicting listeners", () => {
    expect(() =>
      createHostProxyConfig({
        ...options,
        hostname: "example.com\nadmin :9999",
      })
    ).toThrow();
    expect(() =>
      createHostProxyConfig({ ...options, hostId: "broken" })
    ).toThrow();
    expect(() =>
      createHostProxyConfig({ ...options, acmePort: options.httpsPort })
    ).toThrow();
    expect(() => createHostProxyConfig({ ...options, webPort: 0 })).toThrow();
  });
});
