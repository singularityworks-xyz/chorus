import { rootCertificates } from "node:tls";
import type { RelayMachineConnection } from "@chorus/contracts";

/** frpc skips certificate verification without an explicit trusted CA file. */
export function trustedRelayAuthorities(): string {
  if (rootCertificates.length === 0) {
    throw new Error(
      "Trusted authorities are unavailable; refusing to start the relay connector"
    );
  }
  return rootCertificates.join("\n");
}

export function createTunnelConfig(
  connection: RelayMachineConnection,
  options: { caFile: string; httpsPort: number; acmePort: number }
): string {
  if (!options.caFile) {
    throw new Error("an explicit trusted CA file is required");
  }
  const server = new URL(connection.serverUrl);
  if (
    server.protocol !== "https:" ||
    server.username ||
    server.password ||
    server.port ||
    server.pathname !== "/" ||
    server.search ||
    server.hash
  ) {
    throw new Error("a secure relay origin is required");
  }
  for (const port of [options.httpsPort, options.acmePort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("invalid local proxy port");
    }
  }
  // Quoted configuration strings, never shell text. This protected file must
  // not be logged or served. Its machine credential is relay-scoped only.
  const quote = JSON.stringify;
  return [
    `serverAddr = ${quote(server.hostname)}`,
    "serverPort = 443",
    `user = ${quote(connection.hostId)}`,
    'transport.protocol = "wss"',
    "transport.tls.enable = true",
    `transport.tls.serverName = ${quote(server.hostname)}`,
    `transport.tls.trustedCaFile = ${quote(options.caFile)}`,
    "transport.heartbeatInterval = 15",
    "transport.heartbeatTimeout = 45",
    "loginFailExit = false",
    'log.level = "error"',
    'log.to = "console"',
    'auth.method = "oidc"',
    'auth.additionalScopes = ["HeartBeats", "NewWorkConns"]',
    `auth.oidc.clientID = ${quote(connection.clientId)}`,
    `auth.oidc.clientSecret = ${quote(connection.clientSecret)}`,
    `auth.oidc.audience = ${quote(connection.audience)}`,
    'auth.oidc.scope = "relay:connect"',
    `auth.oidc.trustedCaFile = ${quote(options.caFile)}`,
    `auth.oidc.tokenEndpointURL = ${quote(connection.tokenEndpoint)}`,
    `auth.oidc.additionalEndpointParams.resource = ${quote(connection.audience)}`,
    "[[proxies]]",
    'name = "https"',
    'type = "https"',
    'localIP = "127.0.0.1"',
    `localPort = ${options.httpsPort}`,
    `customDomains = [${quote(connection.hostname)}]`,
    "[[proxies]]",
    'name = "acme"',
    'type = "http"',
    'localIP = "127.0.0.1"',
    `localPort = ${options.acmePort}`,
    `customDomains = [${quote(connection.hostname)}]`,
    'locations = ["/.well-known/acme-challenge/"]',
    "",
  ].join("\n");
}
