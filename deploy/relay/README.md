# Central connection infrastructure

This deployment belongs on the operator's VPS. It runs HAProxy, Caddy, frps,
the relay account application, and PostgreSQL. **Do not run Chorus Serve,
OpenCode, workspace databases, or user repositories here.**

The host images in the root Dockerfile belong on user machines. They are not
relay images. Central Caddy owns only the account and tunnel-control TLS keys;
user HTTPS is passed by SNI to frps and terminates on each user's host.

## Status

Implementation is in progress. This is not yet a public deployment quickstart.
PostgreSQL enrollment/concurrency, real frp routing, CA provisioning/renewal,
container shutdown/restore, capacity, and mobile acceptance remain release
gates. Do not open public registration before these and the security assessment
pass. Docker is currently unavailable on the implementation machine.

## Configuration and routing

Use the example environment with real operator-owned domains, a dedicated
database role, Google/GitHub OAuth applications (callbacks under
`/api/auth/callback/google` and `/api/auth/callback/github`), and Turnstile keys
restricted to the account hostname. Never commit the resulting environment.

The account and connect domains and `*.RELAY_HOSTS_DOMAIN` resolve to the relay.
Use a separate registered domain for user hostnames. Obtain enough certificate
issuance capacity for unique host keys before public signup.

Build the relay portal with `bun run --cwd apps/relay build`, explicitly migrate
with `bun apps/relay/src/migrate.ts`, and render proxy configuration with
`bun apps/relay/src/render-config.ts <private-output-directory>`. Then validate
the generated HAProxy, Caddy, and frps configs with their actual binaries before
starting them. These are operator installation steps, not end-user onboarding.

The current implementation targets frp **0.71.1** and Caddy **2.11.7**. Pin
verified artifacts in the release pipeline; no runtime download or `latest` tag
is permitted. The generated configuration assumes services on one Linux host:

- Public: TCP 80 (ACME challenges only), TCP 443 (TLS routing).
- Loopback only: 7000 (frp control), 7080/7443 (ACME/encrypted host traffic),
  8080/8444 (central Caddy), 8081 (accounts), 8082 (frp authorization), PostgreSQL.
- Caddy accepts PROXY protocol only from loopback and overwrites client IP
  headers. Never expose the account/plugin listeners or trust arbitrary headers.

frpc's default TLS verifier is unsafe without an explicit CA file. User hosts
must supply the pinned CA bundle configuration implemented by `tunnel-config.ts`.
This was confirmed in the pinned frp source, not assumed from its TLS flag:
https://github.com/fatedier/frp/blob/v0.71.1/pkg/transport/tls.go

Public access is dependency-sensitive: relay failure interrupts remote
connections while local work continues. Revocation blocks new routes and must
close existing streams through heartbeat rejection within the configured bound;
qualify that behavior with real frp before release.
