import { describe, expect, test } from "bun:test";
import { authorizeProxy, authorizeTunnelGrant } from "./policy";

const host = {
  clientId: "one-host-machine-client",
  hostId: crypto.randomUUID(),
  hostname: "h-a123.hosts.example.net",
  revoked: false,
};
const https = {
  proxy_name: `${host.hostId}.https`,
  proxy_type: "https",
  custom_domains: [host.hostname],
};
const acme = {
  proxy_name: `${host.hostId}.acme`,
  proxy_type: "http",
  custom_domains: [host.hostname],
  locations: ["/.well-known/acme-challenge/"],
};

describe("relay tunnel authorization", () => {
  test("permits only the enrolled host's HTTPS and ACME routes", () => {
    expect(authorizeProxy(https, host)).toBe(true);
    expect(authorizeProxy(acme, host)).toBe(true);
    for (const override of [
      { proxy_type: "tcp", remote_port: 22 },
      { custom_domains: ["other.hosts.example.net"] },
      { custom_domains: [host.hostname, "extra.example.net"] },
      { custom_domains: [`*.${host.hostname}`] },
      { proxy_name: "another-user.https" },
      { group: "share-traffic" },
      { subdomain: "extra" },
      { use_compression: true },
      { host_header_rewrite: "internal" },
      { locations: ["/"] },
      { headers: { authorization: "replace" } },
    ]) {
      expect(authorizeProxy({ ...https, ...override }, host)).toBe(false);
    }
    expect(authorizeProxy({ ...acme, locations: ["/"] }, host)).toBe(false);
    expect(
      authorizeProxy(
        { ...acme, locations: ["/.well-known/acme-challenge/", "/auth"] },
        host
      )
    ).toBe(false);
    expect(authorizeProxy(https, { ...host, revoked: true })).toBe(false);
  });

  test("a valid signature alone does not authorize another host or revoked registration", () => {
    const grant = {
      client_id: host.clientId,
      host_id: host.hostId,
      token_kind: "relay_host",
      scope: "relay:connect",
    };
    expect(authorizeTunnelGrant(grant, host)).toBe(true);
    expect(
      authorizeTunnelGrant({ ...grant, host_id: crypto.randomUUID() }, host)
    ).toBe(false);
    expect(
      authorizeTunnelGrant({ ...grant, client_id: "other-client" }, host)
    ).toBe(false);
    expect(
      authorizeTunnelGrant({ ...grant, scope: "relay:enroll" }, host)
    ).toBe(false);
    expect(authorizeTunnelGrant(grant, { ...host, revoked: true })).toBe(false);
  });
});
