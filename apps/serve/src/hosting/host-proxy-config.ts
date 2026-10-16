import { hostIdSchema } from "@chorus/contracts";

const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** The public TLS endpoint lives on the user's host, behind the opaque relay. */
export function createHostProxyConfig(options: {
  hostname: string;
  hostId: string;
  servePort: number;
  webPort: number;
  httpsPort: number;
  acmePort: number;
}): string {
  hostIdSchema.parse(options.hostId);
  if (!HOSTNAME.test(options.hostname)) {
    throw new Error("invalid public host name");
  }
  const ports = [
    options.servePort,
    options.webPort,
    options.httpsPort,
    options.acmePort,
  ];
  if (
    ports.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65_535
    ) ||
    new Set(ports).size !== ports.length
  ) {
    throw new Error("host listener ports must be distinct valid ports");
  }
  return `{
  admin off
  persist_config off
  grace_period 2s
  http_port ${options.acmePort}
  https_port ${options.httpsPort}
  default_bind 127.0.0.1
  auto_https disable_redirects
  servers {
    protocols h1 h2
    strict_sni_host on
    max_header_size 32KB
  }
}

http://${options.hostname} {
  bind 127.0.0.1
  respond 404
}

https://${options.hostname} {
  bind 127.0.0.1
  tls {
    issuer acme {
      disable_tlsalpn_challenge
    }
  }
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    -Server
  }
  @foreign_origin {
    header Origin *
    not header Origin https://${options.hostname}
  }
  respond @foreign_origin 403
  @bootstrap path /auth/local-session /auth/local-session/* /api/auth/local-session /api/auth/local-session/*
  respond @bootstrap 403
  handle /auth/relay-probe {
    header Content-Type application/json
    header Cache-Control no-store
    respond ${JSON.stringify(JSON.stringify({ hostId: options.hostId }))} 200
  }
  @serve path /ws /auth/* /voice/* /health
  handle @serve {
    reverse_proxy 127.0.0.1:${options.servePort}
  }
  handle {
    reverse_proxy 127.0.0.1:${options.webPort}
  }
}
`;
}
