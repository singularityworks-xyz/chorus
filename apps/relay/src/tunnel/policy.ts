import { hostIdSchema } from "@chorus/contracts";
import { z } from "zod";

export const tunnelGrantSchema = z.object({
  client_id: z.string().min(1),
  host_id: hostIdSchema,
  scope: z.string(),
  token_kind: z.literal("relay_host"),
});

export interface TunnelHost {
  clientId: string;
  hostId: string;
  hostname: string;
  revoked: boolean;
}

const proxySchema = z.object({
  proxy_name: z.string(),
  proxy_type: z.enum(["http", "https"]),
  custom_domains: z.array(z.string()).length(1),
  subdomain: z.string().optional(),
  group: z.string().optional(),
  group_key: z.string().optional(),
  locations: z.array(z.string()).optional(),
  host_header_rewrite: z.string().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  route_by_http_user: z.string().optional(),
  use_compression: z.boolean().optional(),
});

/** One exact host, HTTPS traffic and ACME challenges only. No general proxy. */
export function authorizeProxy(input: unknown, host: TunnelHost): boolean {
  const parsed = proxySchema.safeParse(input);
  if (!parsed.success || host.revoked) {
    return false;
  }
  const proxy = parsed.data;
  if (
    proxy.custom_domains[0] !== host.hostname ||
    proxy.subdomain ||
    proxy.group ||
    proxy.group_key ||
    proxy.host_header_rewrite ||
    proxy.route_by_http_user ||
    proxy.use_compression ||
    Object.keys(proxy.headers ?? {}).length > 0
  ) {
    return false;
  }
  if (proxy.proxy_type === "https") {
    return (
      proxy.proxy_name === `${host.hostId}.https` &&
      (proxy.locations?.length ?? 0) === 0
    );
  }
  return (
    proxy.proxy_name === `${host.hostId}.acme` &&
    proxy.locations?.length === 1 &&
    proxy.locations[0] === "/.well-known/acme-challenge/"
  );
}

export function authorizeTunnelGrant(
  input: unknown,
  host: TunnelHost
): boolean {
  const grant = tunnelGrantSchema.safeParse(input);
  return (
    grant.success &&
    !host.revoked &&
    grant.data.host_id === host.hostId &&
    grant.data.client_id === host.clientId &&
    grant.data.scope.split(" ").includes("relay:connect")
  );
}
