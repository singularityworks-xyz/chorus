import {
  type RelayOperatorConfig,
  relayOperatorConfigSchema,
} from "@chorus/contracts";

/** Central routing only. Host traffic is never sent to a TLS terminator here. */
export function renderRelayDeployment(input: RelayOperatorConfig) {
  const config = relayOperatorConfigSchema.parse({
    accountOrigin: input.accountOrigin,
    tunnelOrigin: input.tunnelOrigin,
    hostsDomain: input.hostsDomain,
  });
  const accounts = new URL(config.accountOrigin).hostname;
  const connect = new URL(config.tunnelOrigin).hostname;
  if (
    accounts === connect ||
    [accounts, connect].some(
      (name) =>
        name === config.hostsDomain || name.endsWith(`.${config.hostsDomain}`)
    )
  ) {
    throw new Error("Control and user host domains must be isolated");
  }
  const haproxy = `global
    maxconn 4000
    log stdout format raw local0
defaults
    timeout connect 5s
    timeout client 1h
    timeout server 1h
    timeout tunnel 1h
frontend https_connections
    bind :443
    mode tcp
    tcp-request inspect-delay 5s
    tcp-request content accept if { req.ssl_hello_type 1 }
    acl control req.ssl_sni -i ${accounts} ${connect}
    acl user_host req.ssl_sni -m end .${config.hostsDomain}
    use_backend control_tls if control
    use_backend host_tls if user_host
    default_backend reject_unknown
backend control_tls
    mode tcp
    server control 127.0.0.1:8444 send-proxy-v2
backend host_tls
    mode tcp
    server encrypted_hosts 127.0.0.1:7443
backend reject_unknown
    mode tcp
    tcp-request content reject
frontend certificate_challenges
    bind :80
    mode http
    acl acme path_beg /.well-known/acme-challenge/
    acl control hdr(host),field(1,:) -i ${accounts} ${connect}
    acl user_host hdr_end(host) -i .${config.hostsDomain}
    http-request deny deny_status 403 unless acme
    http-request deny deny_status 403 unless METH_GET
    use_backend control_acme if control
    use_backend host_acme if user_host
    http-request deny deny_status 404 unless control or user_host
backend control_acme
    mode http
    server control 127.0.0.1:8080 send-proxy-v2
backend host_acme
    mode http
    server challenges 127.0.0.1:7080
`;

  const caddy = `{
    admin off
    http_port 8080
    https_port 8444
    default_bind 127.0.0.1
    auto_https disable_redirects
    servers {
        protocols h1 h2
        max_header_size 32KB
        listener_wrappers {
            proxy_protocol {
                timeout 2s
                allow 127.0.0.1/32
                fallback_policy require
            }
            tls
        }
    }
}
${config.accountOrigin} {
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:8081 {
        header_up X-Real-IP {remote_host}
        header_up -Forwarded
    }
}
${config.tunnelOrigin} {
    @tunnel {
        path /~!frp
        header Upgrade websocket
    }
    handle @tunnel {
        reverse_proxy 127.0.0.1:7000
    }
    handle {
        respond 404
    }
}
http:// {
    respond 404
}
`;

  const frps = `bindAddr = "127.0.0.1"
bindPort = 7000
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = 7080
vhostHTTPSPort = 7443
maxPortsPerClient = 2
transport.heartbeatTimeout = 45
# TLS is verified at the WSS ingress; the clear backend is loopback-only.
transport.tls.force = false
auth.method = "oidc"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]
auth.oidc.issuer = ${JSON.stringify(`${config.accountOrigin}/api/auth`)}
auth.oidc.audience = ${JSON.stringify(`${config.accountOrigin}/tunnel`)}
[[httpPlugins]]
name = "chorus-authorization"
addr = "127.0.0.1:8082"
path = "/frp"
ops = ["Login", "NewProxy", "Ping", "NewWorkConn", "NewUserConn", "CloseProxy"]
`;
  return { haproxy, caddy, frps };
}
