# User-owned host packaging

The root Dockerfile has `web` and `serve` targets. Both run as UID/GID 10001
under an init process. The web target runs Next's standalone server, including
its server routes; Serve never has to pretend the Next build is a static SPA.

These images, their Caddy proxy, repositories, and persistent state belong on
the **user's laptop/VPS**, never the operator's relay VPS. The proxy accepts a
host-specific `CHORUS_PUBLIC_HOST`, keeps TLS keys in host-owned storage, routes
WS and voice to Serve and other requests to Next. Set the web container's
`CHORUS_SERVE_URL=http://serve:2000`. Leave browser WS overrides unset.

Persistent data must be owned by 10001:10001. Serve also uses `/data/xdg-data`
and `/data/xdg-config` for engine state/config; mount registered repositories
separately. Supply `CHORUS_TOKEN` through a protected deployment secret.

This is packaging groundwork, **not a deployable relay quickstart yet**. Enrollment,
remote device sessions, routing configuration and settings are implemented;
native transport, certificate and container acceptance remain required.
Do not publish engine ports or reuse a wildcard TLS private key across hosts.

Container build/boot/TLS/shutdown qualification must run with Docker available.
The implementation machine currently has no running Docker daemon.

## Native production connector contract

For a native production installation, Serve and Next standalone must run on the
same machine, on private loopback ports. The managed connector currently targets
that topology; the separate container topology still needs its own qualification.
The release installer sets `CHORUS_RELAY_INSTALLATION` to a trusted installation
definition. This is not an end-user configuration screen:

```json
{
  "operator": {
    "accountOrigin": "https://accounts.operator.example",
    "tunnelOrigin": "https://connect.operator.example",
    "hostsDomain": "hosts.operator-example.net"
  },
  "binaryDirectory": "/opt/chorus/connectors",
  "webPort": 3000,
  "httpsPort": 2443,
  "acmePort": 2080
}
```

The binary directory contains the official `caddy`/`frpc` executables (`.exe` on
Windows) and an installer-owned `manifest.json` with `platform`, `arch`, and
`caddy: {version: "2.11.7", sha256: <reviewed digest>}` /
`frpc: {version: "0.71.1", sha256: <reviewed digest>}`. The installer must verify
release provenance and ship reviewed hashes; generating a manifest from arbitrary
downloaded executables is not a trust mechanism. No runtime download occurs.

The vault, wrapping key, journal and Caddy certificate storage stay under the
user's private `DATA_DIR/host`. Active frpc configuration contains its scoped
machine credential and is private; normal stop removes that file. Children get
an allowlisted environment without provider credentials and start hidden on
Windows. Shutdown cancels network work and stops/kills both children within the
host's shutdown budget. None of these native binaries were executed during the
current Windows test run.

In Settings → Devices → Internet access, the user names and approves their
computer with a Google/GitHub account, compares its signing fingerprint and waits
for verified HTTPS readiness. They copy the public address to the phone and enter
a one-time device code generated on the host. Pause/resume persists locally;
individual browser access can be revoked independently. The laptop must stay
awake. Moving the workspace to another host is not implemented yet.
