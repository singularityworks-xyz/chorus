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
| Packaging/contracts | Next standalone build, separate user-host Docker targets, strict relay/host/release contracts, encrypted storage package, separate private production entry | Fresh container build/boot/shutdown; packaged launcher and browser acceptance |
| Relay accounts | Google/GitHub configuration, Turnstile, secure host cookies, approved enrollment, scoped machine grants, PostgreSQL metadata/quota transactions, account portal | Real provider callbacks, PostgreSQL concurrency/rollback tests and operational cleanup |
| Host authentication | Persistent hashed per-browser sessions, ten-device limit, in-app revocation, WS/push revocation checks, protected production cookies, encrypted internal signing root for managed local entry | Browser/mobile acceptance and packaged first launch |
| Remote connections | frp authorization policy/plugin, SNI passthrough config, local host TLS config, verified native binary manifest, hidden child processes, bounded restart/shutdown, HTTPS readiness probe, settings enrollment/pause/resume; pinned native config checks pass | Release pipeline supplying reviewed native artifacts, actual frp protocol integration, certificates/renewals and reconnect/revocation under load |
| Workspace move | Encrypted host identity, local signed ownership journal, bounded repository/worktree checkpoints, review object packs and verified import into fresh inactive staging; preparation, fencing, release, activation and return-generation tests | Whole-workspace projection/path remapping, review-root discovery/installation, execution barriers, authenticated host pairing/transport, linked agent continuation, recovery UI and browser host switching |
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
- Docker daemon is stopped. Container/PG/real relay/browser qualification has
  not run. The initial sandbox junction failure remains recorded in the baseline
  above.

### Follow-up verification and production local entry

The release asset pages supplied the official archive hashes after GitHub's API
returned 403. Downloads were verified before extracting only the named binaries:

- Caddy 2.11.7 Windows amd64 archive SHA-256:
  `0a1edc0b799512051c57071ce0e798d3f2cf67dc98171366f1d2b326072e3b06`.
- frp 0.71.1 Windows amd64 archive SHA-256:
  `b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821`.
- Hidden `caddy adapt --adapter caddyfile --config <host/central file>` passed
  for both generated Caddyfiles. Hidden `frpc verify -c <file>` and
  `frps verify -c <file>` passed. No tunnel listener was started. This establishes
  configuration compatibility, not real transport/certificate qualification.

Managed native production now enables `CHORUS_LOCAL_ENTRY_ENABLED=true`: its
encrypted vault supplies the internal signing root and an isolated listener binds
`127.0.0.1:2001`. Only the matching loopback frontend Origin, direct peer and
bootstrap header can obtain a protected browser cookie there. Main production
ingress still returns 403 for bootstrap. Remote proxies must never forward 2001.

The follow-up scoped suite passed **455 tests across 45 files**. Bun's broad
`scripts` filter also selected the existing Phase 6 in-process scripted-engine
harness, which completed once with hidden Git invocations; no browser, real agent
engine or E2E runner ran. Future verification should use exact script test paths.
The separate production HTTP check passed through one hidden Next standalone
process: local entry, same-origin mutations, cross-origin denial, protected cookie
forwarding, logout and replay rejection. It is now a CI build-stage check at
`apps/serve/src/auth/testing/production-entry-smoke.ts`. The updated production
Next build, all nine type checks and lint/log gates pass. Browser cookie policy
and packaged launcher acceptance remain required.

Committed checkpoints: `187459c` (hidden check/version helpers), `4b7a53d` (relay
control plane and packaging), `1812990` (host/device access foundation),
`7ce1c95` (private production local entry), `2cc19fd` (repository checkpoints).

### Next delivery order

The repository-transfer increment uses `packages/contracts/src/repository-transfer.ts`
and focused modules/tests under `apps/serve/src/hosting/transfer/`. Checkpoints
contain a full Git bundle, a binary staged patch and exact working-file content
addressed by SHA-256. Import is into a newly created private staging directory,
never an existing checkout. No arbitrary tar extraction, repository config,
hooks, remote URLs, host credentials or device sessions are transferred.
Preflight rejects incomplete history, merge conflicts, special index flags,
symlinks/submodules, unsafe/nonportable names and configured size limits.
Ignored untracked files follow the source's Git ignore policy; Chorus-owned
control/worktree folders are excluded. This increment does not activate a host
or replace the whole-workspace projection and execution barrier work.

Repository staging tests exercise actual hidden Git processes, full/unborn/
detached history, staged and unstaged binary/text changes, deletions, ignored
files, source filters, unsafe index modes, integrity failures and rollback while
preserving existing target files. Limits are 256 MiB per repository checkpoint,
16 MiB per working file and 20,000 files. External filters/object stores,
symlinks, submodules and special index states fail preflight. Windows import
rejects executable-bit changes that its filesystem cannot preserve. File writes
are flushed; POSIX directory entries are flushed too. Windows crash/power-loss
durability still requires platform qualification. This layer has no network
endpoint and cannot start engines or change workspace ownership.

`bun test ./apps/serve/src/hosting/transfer/repository-transfer.test.ts
./packages/contracts/src/repository-transfer.test.ts`: **13 pass, 0 fail,
82 assertions**. `bun run check` and all nine `check-types` packages pass.

The worktree/review follow-up restores real linked Git worktrees under the fresh
repository's `.chorus-worktrees/<boardId>`, preserving their own staged/working
changes and detached history. Conflicting branches, names and mismatched shared
refs fail preflight. The family is limited to 100 linked worktrees and 1 GiB of
declared checkpoint bytes; failed restoration removes only that fresh family.
Explicit review tree roots are packed with their reachable objects, verified and
staged in a fresh bare store. Source config, unrelated objects and snapshot
indexes stay private. Tree paths, modes, counts and content sizes are checked on
both sides. Review-root discovery and installation for remapped paths still need
whole-workspace integration; these primitives do not expose a handoff endpoint.

Transfer Git children disable hooks, filesystem monitors, replacement objects,
lazy fetching and remote protocols. Partial clones, alternates and grafts fail
preflight. This keeps checkpointing from launching network credential helpers.
The environment controls follow the [official Git documentation](https://git-scm.com/docs/git).

The combined repository/worktree/review test selection passes **22 tests,
121 assertions across five files**. Lint/log gates and all nine type checks pass.

1. Qualify the real central/PostgreSQL/frp deployment and install reviewed native
   binaries in a Linux CI environment. Qualify the packaged local-first launcher
   and its separate private entry in actual browsers.
2. Add portable repository, dirty index/worktree, review snapshot and workspace
   transfer with strict file/path/size validation and destination preflight.
3. Drain/fence engine and store execution, exchange signed peer receipts over
   host-terminated TLS, activate staged checkpoints and continue linked runs.
4. Implement move/return/recovery UI, host-generation cache reset and device
   reauthentication, then complete mobile, load and security release gates.
