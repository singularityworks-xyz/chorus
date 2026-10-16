# Self-hosted hosts and central connection relay

Approved product contract: Chorus, repositories, agents, credentials, workspace
state, device permissions, and handoff journals live on users' laptops/VPSs.
The operator's VPS carries encrypted connections and stores only relay accounts,
host registrations, quotas, and operational metadata. It does not run agents,
store workspace backups, or arbitrate workspace ownership.

## Delivery stages

- [ ] Production host packaging and shared host/transfer contracts.
- [ ] Google/GitHub accounts, approved host enrollment, device sessions/revocation.
- [ ] frp TLS passthrough, host certificates, reconnects, quotas, mobile pairing.
- [ ] Portable code/history export, worktrees, review artifacts, staged import.
- [ ] Host-owned signed handoff, durable fencing, continuation and recovery UX.
- [ ] Isolated Linux browser/container qualification and security assessment.

## Fixed decisions

Public signup; initial capacity 100 online hosts; three hosts/account; ten
connected browsers/workspace. Only installed VPS hosts are linked; no SSH
provisioning. Whole-workspace moves checkpoint runs and continue as new linked
runs. Unknown external tool outcomes need review. Ignored files and machine
credentials are excluded; destination credentials are configured independently.

The source stages and verifies the target, fences itself durably, then sends a
signed ownership release. The target activates only against that release and
its verified checkpoint. A restart/timeout never clears a fence. Recovery uses
the hosts' durable receipts, with no automatic failover or central execution
lease. Manual edits on a passive checkout are preserved and conflicts block
replacement.

Use host-terminated HTTPS through frp. TLS private keys remain on hosts. The
relay sees routing/timing/volume. DNS/certificate infrastructure is trusted;
this is not a claim of protection against every infrastructure compromise.
Target OWASP ASVS L2 controls, not regulatory certification. Public launch
requires certificate capacity, independent security review, measured load, and
desktop/mobile acceptance. No local Windows browser/E2E runner may run.

## Baseline — 2026-10-16

`bun run check` and `bun run check-types` passed. Focused contracts/local-access
tests passed. The existing web static symlink test failed with sandbox EPERM
while creating its Windows junction (14 passed, 1 failed); retain the test.
Context7 is unavailable; use installed framework docs and official primary
documentation. Implementation is on `codex/self-hosted-relay`, branched from
`codex/workspace-device-completion`.

## Implementation checkpoint — 2026-10-16

The six delivery stages above remain open. This checkpoint implements foundations
and remote-access controls; it does **not** complete VPS handoff or qualify a
public deployment.

| Area | Implemented | Remaining gate/work |
| --- | --- | --- |
| Packaging/contracts | Next standalone build, separate user-host Docker targets, strict relay/host/release contracts, encrypted storage package | Fresh container build/boot/shutdown; packaged local-first production entry |
| Relay accounts | Google/GitHub configuration, Turnstile, secure host cookies, approved enrollment, scoped machine grants, PostgreSQL metadata/quota transactions, account portal | Real provider callbacks, PostgreSQL concurrency/rollback tests and operational cleanup |
| Host authentication | Persistent hashed per-browser sessions, ten-device limit, in-app revocation, WS/push revocation checks, protected production cookies | Browser/mobile acceptance; production local bootstrap must remain separated from remote ingress |
| Remote connections | frp authorization policy/plugin, SNI passthrough config, local host TLS config, verified native binary manifest, hidden child processes, bounded restart/shutdown, HTTPS readiness probe, settings enrollment/pause/resume | Release pipeline supplying reviewed native artifacts, actual frp/Caddy configuration/protocol tests, certificates/renewals and reconnect/revocation under load |
| Workspace move | Encrypted host identity and local signed ownership journal; preparation, fencing, release, activation and return-generation tests | Portable repository/worktree/review export/import, execution barriers, authenticated host pairing/transfer, linked agent continuation, recovery UI and browser host switching |
| Release security | Strict endpoint pinning, purpose-separated encrypted credentials/signatures, negative authorization tests and dependency failure handling | ASVS L2 assessment, independent review, certificate capacity, Linux container/browser CI, phone acceptance and 100-host load qualification |

Runtime remote access is optional and defaults to unconfigured. It refuses to
expose a development frontend. An operator-installed definition pins the central
relay endpoints and reviewed native binaries. No user may substitute relay
endpoints through a browser request. A configured native production installation
uses settings to enroll; it only advertises a public address after local frontend/
backend checks and a real HTTPS probe through that relay succeed.

The ownership journal is deliberately **not yet attached to live workspace/engine
execution**. No move-to-VPS control is offered until the portable checkpoint and
execution barrier work is complete. Never interpret passing journal tests as an
implemented handoff.

### Verification evidence

- `bun run check`: green; formatting/lint and log gate pass.
- `bun run check-types`: green across all nine packages.
- Explicitly scoped `bun test` over contracts, security, relay, host primitives,
  auth, in-process local pairing, config, hub, push and origin policy: **297 pass,
  0 fail across 32 files**. No browser, E2E runner, engine or connector binary was
  started. Vault tests invoke only hidden native Windows ACL utilities.
- Real Better Auth SQLite test creates an approved-account machine client,
  exchanges the same scope/resource/audience parameters used by frpc, verifies
  RS256 host claims with real JWKS, denies unprivileged browser client creation,
  and verifies disabled clients cannot obtain another grant.
- `bun run --cwd apps/web build`: production standalone build passes, including
  new device and remote-access routes. Relay portal build passes.
- Docker daemon is stopped. Container/PG/native relay/browser qualification has
  not run. GitHub release metadata retrieval returned HTTP 403; no unverified
  binaries were downloaded or executed. The initial sandbox junction failure
  remains recorded in the baseline above.

### Next delivery order

1. Qualify the real central/PostgreSQL/frp deployment and install reviewed native
   binaries in a Linux CI environment. Implement production local-first launch
   without letting a tunnel proxy satisfy local-bootstrap checks.
2. Add portable repository, dirty index/worktree, review snapshot and workspace
   transfer with strict file/path/size validation and destination preflight.
3. Drain/fence engine and store execution, exchange signed peer receipts over
   host-terminated TLS, activate staged checkpoints and continue linked runs.
4. Implement move/return/recovery UI, host-generation cache reset and device
   reauthentication, then complete mobile, load and security release gates.
