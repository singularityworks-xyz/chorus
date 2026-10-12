# Chorus — Phase 6 and Phase 7 Completion Plan

Date: 2026-10-12. Status: **implementation is present; release verification is incomplete**.

This is the execution companion for P6/P7 in `implementation-plan.md`, based on
the current source and all eight documents in `.context`. `specsheet.md` remains
the product authority. This plan specifies the remaining work; it does not mark
either phase complete or override existing verification requirements.

## 1. Completion outcome

Phase 6 is complete when repository onboarding is authorized independently of
boards, parallel boards have isolated checkouts, board removal cannot delete a
live agent's checkout, and engine/session/event-stream recovery is verified.

Phase 7 is complete when an opted-in device with no live Chorus socket receives
a permission/question notification, opens the correct board/card, and can answer
it through the existing authenticated controls. Push failures must leave agent
execution and the durable workspace state unaffected.

Keep the single operator, SQLite writer, HTTP commands, and store-to-WS emit
path. External SDK and push shapes stay inside their adapters. Additional
notification/lifecycle metadata is operational bookkeeping in the existing
database, not another workspace state channel.

## 2. Evidence and remaining gaps

| Area | Current implementation and evidence | Remaining acceptance |
|---|---|---|
| Repository authority, D1 | Operator-approved `RepositoryRegistry`, canonical path validation, server-computed checkout paths, store-level enforcement, and targeted tests | Manual folder-picker check; the full scripted run below is not green |
| Worktree lifecycle | Serialized provisioning, failed-commit compensation, restart cleanup intents, dirty-worktree preservation, and real-Git concurrency/removal tests | Repeat the complete eight-run qualification after fixing its approval-event timeout |
| Session ownership | Board-scoped session lookup and exact checkout validation; session diff now resolves the board's checkout through the engine adapter | Full route through approval, result, WebSocket mirrors, and both diff paths |
| Engine identity and pool | SDK and packaged CLI are pinned at 1.19.0; health/version checks and `OPENCODE_PER_WORKTREE` registry are wired; pool lifecycle tests pass | Sustained load/capacity evidence in the deployment environment |
| Agent stream recovery | SDK events normalize into Chorus types; retry, reconciliation, and reconnect tests pass | Full scripted qualification currently times out before approvals reach the board state |
| Legacy import, D4 | Import validates roots and rejects colliding checkout bindings before parking the source; collision-preservation test passes | None for the collision safety change; import remains disabled by default |
| Board removal, D6 | Task service reserves, aborts, waits for idle, commits removal, then cleans up; failure and concurrent-removal tests pass | Complete qualification with real SSE and board events |
| Device identity | Signed stable device cookie, device-bound one-use tickets, and per-device socket presence are implemented and tested | Multi-browser end-to-end recovery remains unrun |
| Push delivery | Persisted key/subscription state, opt-in recovery, bounded retries, shutdown cancellation, and 410 cleanup tests pass | Real Chrome desktop and installed iOS Safari acceptance |
| Notification UI | Push-only worker validates payloads and same-origin targets; client opt-in and login return path are implemented | Verify on real devices and unauthenticated notification click |
| Auth boundary | Explicit public frontend paths and expanded auth inventory tests cover catalogs and push routes | Run the process-backed auth matrix as part of the release verification |
| Browser E2E | Existing Playwright configuration and suite remain available; no browser E2E was run in this execution at the operator's request | Run only after explicit approval; it is not evidence in this report |

## Verification recorded 2026-10-12

- `bun run check`: passed; log gate green.
- `bun run check-types`: passed across all seven workspace packages.
- `bun run build`: passed, including the Next.js production build and `/api/sessions/[sessionID]/diff` route.
- Focused P6/P7 suite: 299 tests passed across 24 files; the session-diff API suite passed 28 tests across four files; the legacy store suite passed 28 tests. Counts overlap between focused commands.
- The non-browser eight-run harness was attempted. It created isolated repositories and queued work, but timed out while waiting for all approval events to reach the board lanes. The run is not counted as passing evidence.
- No Playwright/E2E test, real-model inference run, ten-minute load run, or real-device push acceptance was performed.

## 3. Decisions for implementation

### Repository onboarding

Use a `RepositoryRegistry` module independent of board records. Its interface
resolves a registered repository and validates a board binding; callers do not
learn how paths, Git identity, or persisted registrations are handled.

- Add `CHORUS_REPOSITORY_ROOTS`, a JSON array of operator-approved absolute Git
  checkout roots. Canonicalize existing paths and verify them with argument-array
  Git calls. A configured workspace parent is not blanket authority over all its
  children.
- Local onboarding can also register the directory returned by the existing
  **host-native** folder picker after validation. Arbitrary client-supplied paths
  cannot register themselves. Disable host GUI picking in production; the VPS
  project selector lists configured roots.
- Store trusted local registrations in `meta` under a versioned namespace.
  Production authority comes from the operator configuration. Existing boards
  do not automatically grant authority; provide an upgrade checklist to review
  and configure their roots. Unapproved boards remain preserved but cannot run
  commands until authorized.
- Keep existing seed compatibility by accepting `repo.directory` only when it
  exactly resolves to an approved root. Server-compute `worktree` and other
  executable path fields; never trust supplied worktree/sandbox paths.
- Validate inside the store's serialized board-create path as well as HTTP.
  Imported data and internal callers must cross the same interface.
- Directory equality uses canonical filesystem identity and platform-aware path
  operations. Containment uses `path.relative`, not a hardcoded slash or a raw
  string prefix. Validate managed ancestors before mkdir/Git side effects and
  revalidate the final real path.

### Checkout lifecycle and removal

Use a `BoardLifecycle` module at the command layer that owns agent control. The
store owns typed, durable lifecycle intents and serialization; it does not gain
a direct OpenCode dependency.

Creation is serialized: authorize root → reserve stable board/operation ID →
record provisioning intent → create checkout if necessary → compute candidate
state → commit board event and operation result → release reservation. On a
failed commit, compensate a newly created clean checkout; retain a cleanup
intent if compensation fails. A retry with the same mutationId must recover the
same operation rather than create another board/worktree.

Removal follows this order:

1. Reserve the board for closing and persist the intent. Reject new prompts,
   redirects, and other conflicting engine commands for that board with a typed
   `board_closing` error. Concurrent removals share one operation.
2. Stop queued task dispatch, abort the owned live run, and verify quiescence
   through the engine interface with a bounded timeout. Waiting for engine
   events happens **outside** the SQLite serial queue; otherwise events needed
   to prove idle can be blocked behind the removal itself.
3. Inspect the checkout. A dirty managed worktree is retained and the operator
   receives an actionable error; do not silently force-delete agent edits.
   Include untracked and potentially valuable ignored files in the preservation
   policy; a clean `git status` alone is insufficient evidence for deletion.
   Primary checkouts are never removal targets.
4. Commit `board.removed` and a pending cleanup record atomically. Only after a
   successful durable commit may the exact owned, clean worktree be removed.
5. Remove the checkout inside the serialized lifecycle cleanup path, stop its
   stream/watchdog, release its engine lease, and finish the cleanup record.
   Failures remain recoverable at boot, even after the last board for that repo
   disappears. Do not infer orphan locations solely from surviving boards.

A board-removal commit listener alone is insufficient: the current deletion
happens before that listener and the event no longer contains the old session
binding. Capture the binding in the lifecycle intent before removal. Revalidate
ownership/containment before every retry. Unknown or dirty orphans are preserved
and reported for recovery.

### Engine and session model

Keep one shared engine by default. Complete `OPENCODE_PER_WORKTREE=true` as the
original P6 task requests; do not leave the switch silently inert.

- Resolve the official CLI from an exact local dependency/artifact matching SDK
  **1.19.0**, not the first global binary on PATH. Verify the official package
  and its platform packaging before adding it with Bun; record both pins in the
  ledger. Package/release availability is an implementation prerequisite.
- Separate managed local mode from externally managed mode. An external URL is
  never a reason to spawn an unrelated local child. Ambiguous auto-start/remote
  configuration fails with an actionable config error.
- Probe the normalized configured base URL, validate JSON with a schema, and
  require `healthy:true`. Carry configured engine authentication through the
  adapter and probes without logging credentials.
- Check SDK equality at every initial/adopted connection and successful
  restart. Serve can boot with an intentionally absent engine for the existing
  smoke, but prompts receive an engine-unavailable error until health/version
  is verified. A mismatched or unidentifiable engine never accepts work.
- Introduce an `EngineRegistry` module with a small directory/board-resolution
  interface. Shared mode resolves to one engine. Pool mode manages one lease per
  canonical checkout, bounded to the v1 concurrency budget, using race-safe port
  allocation and single-flight startup. All prompt, approval, question, abort,
  redirect, diff/revert, watchdog, and subscription paths resolve the same lease.
- Every pool child has its own generation, readiness/liveness checks, restart
  budget, and observed version. Reclaim only an unreferenced idle lease. Adopted
  or remote engines are never killed by Chorus. Shutdown drains/stops owned
  children concurrently within the existing five-second budget.
- Persist enough board/session ownership to restore routing and subscription
  state. Only a verified board + engine + checkout match allows session reuse.
  A supplied unrelated session ID cannot override the board's session. When
  directory identity is unknown, use an existing verified binding only for the
  same engine generation; otherwise return a typed unavailable/conflict error.
- Hard redirect forks within the board's checkout and records the returned
  session before subsequent commands. Directory migration must create a valid
  target session, using a cross-directory fork only if the installed SDK/engine
  supports it. Do not blindly pass an old session ID with a different directory.
- Engine death/replacement marks affected active runs as errors through the
  normal store event path. Do not silently retry a shell-executing prompt.

### Push configuration, devices, and navigation

- Add explicit `PUSH_ENABLED`. Default is disabled unless a complete configured
  VAPID pair enables it; an explicit false disables it. With explicit true,
  reuse persisted keys or generate once if no pair exists. This resolves the
  conflict between P7 auto-generation and `.env.example`'s absent-keys-disabled
  wording. Add a valid `VAPID_SUBJECT` contact URI for enabled push.
- Validate complete key pairs, persist generated keys in existing SQLite meta,
  identify the active key set, and reject unexplained key changes. Rotation is
  an explicit documented operation that requires device resubscription. Public
  configuration exposes capability/public key only; private material never
  enters browser state, logs, or workspace events.
- Create a signed, random HttpOnly device cookie through an authenticated device
  registration endpoint. Device IDs are identifiers, not authentication. Bind
  single-use WS tickets to this verified device too; update ticket decoding with
  compatibility tests for older entries.
- Extend hub registration with verified device identity. Track healthy,
  authenticated, ready connections by stable Elysia connection ID. Two tabs
  count as two connections; closing one does not mark the device offline.
  Heartbeat expiry, auth failure, logout, and shutdown remove presence correctly.
- Suppress push only for the destination device with an open healthy socket.
  An online laptop must not suppress notifications to an offline phone. This
  follows spec §10 literally; visibility alone is not the suppression rule.
- Version/migrate `push_subs` to associate endpoint with device, expiration,
  active VAPID key, and update time. Bound subscription counts to the documented
  device budget. Replacement and deletion are transactional and idempotent.
  Log-out disables this device's push and sockets; log-in can reconcile the
  browser's retained subscription. An expired login on notification click must
  return the operator to the requested card after reauthentication.
- Use `/?board=<boardId>&card=<cardId>` for the canonical notification target.
  The spec requires focus, not a particular pathname; this works with the
  existing workspace page and avoids inventing a dynamic route incompatible
  with future static serving. Supersede the original P7 `/board/<id>` example.
  Validate same-origin relative navigation and preserve it through login. Focus
  is local to this device, not a persisted selection mutation on every mirror.
- Add only the manifest/icons/Home Screen metadata needed for iOS notifications
  and a push-only service worker. Record the narrow clarification in spec §11
  during implementation: general installation flows and an offline shell remain
  deferred. No caching of authenticated pages, API responses, or credentials.

## 4. Work packages and implementation order

### T0 — Restore a trustworthy verification baseline

Files: root scripts/config, affected test fixtures, logger test setup,
`.github/workflows/ci.yml`, existing `e2e/*` and `playwright.config.ts` as needed.

- Reproduce from an isolated clean install with the pinned Bun runtime on Linux
  (the production CI target), then Windows (the current development host).
  Reconcile runtime/packageManager pins based on verified results.
- Classify all earlier failures. Repair real type/global resolution defects and
  PostHog shutdown typing. External telemetry must not contact a production
  service in deterministic tests; supply the external transport seam.
- Port the log gate to a Bun script or provide an equivalent portable entrypoint
  with matching detection behavior. Do not weaken it to make Windows pass.
- Use OS-native temporary paths in fixtures. Keep symlink/path-escape assertions
  meaningful. Run POSIX 0600 and SIGKILL-specific guarantees on Linux; document
  precise platform limitations rather than skipping entire security suites.
- Ensure process fixtures stop only children they own and delete only validated
  fixture directories. Avoid port-based killing of unrelated development servers.

Exit: clean-install lint/log gate/types/unit/integration results recorded; no
unexplained failures. Existing sync/auth tests remain intact.

### P6-A — Repository authority and session ownership (D1)

Files: `projects/repository-registry.ts` (new), `auth/roots.ts`, `routes/projects.ts`,
`projects/service.ts`, `routes/workspace.ts`, `workspace/store.ts`,
`tasks/board-task-service.ts`, `tasks/session-directory.ts`, relevant shared
contracts and project selector/composer code, config/env documentation.

Implement the onboarding and reuse decisions in §3. Replace the broad frontend
auth exemption with explicit public frontend/static handling; protect all HTTP
commands/catalogs including `/models`, `/providers`, and new routes. Keep route
authentication ahead of payload validation.

Tests: configured and picked root onboarding; empty registry; existing board
upgrade; nonexistent/non-Git/unregistered paths; client worktree spoofing;
prefix siblings; symlink aliases/escapes; Windows separators/case where relevant;
first board acceptance; store-direct rejection; unauthorized route inventory;
same-session continuity; unrelated-session rejection; unknown engine directory;
hard fork binding and subsequent approval/revert in the correct checkout.

Exit: no client can obtain filesystem authority by creating a board or naming a
session. Happy-path repository onboarding works on desktop and phone.

### P6-B — Transactional checkout lifecycle (D4, D6)

Files: `tasks/board-lifecycle.ts` (new), `workspace/store.ts`, `workspace/db.ts`,
`projects/worktree-manager.ts`, startup/shutdown wiring, removal UI, import and
restore documentation, related schemas/events if a visible lifecycle state is needed.

Implement serialized lifecycle intents and compensation. Compute the projected
candidate before appending the durable event, as required by spec §5. Reconcile
intents at boot before accepting conflicting work. Migrate legacy snapshots only
after validating all roots/bindings; reject colliding checkouts with actionable
instructions and leave the source intact. Rename it only after durable import.
Keep the legacy flag disabled by default.

Tests use real Git/SQLite: first checkout preserved; extra boards isolated;
ten simultaneous creates; mutation retry after process death; Git failure;
projection/DB commit failure after provisioning; abort-before-cleanup ordering;
abort timeout; removal-vs-prompt race; failed removal commit preserves checkout;
dirty/untracked/valuable ignored files survive removal/orphan recovery; symlinked container
rejected before writes; cleanup failure survives restart with zero remaining
boards; unrelated Git worktrees untouched; import collisions rejected without
renaming/writing; validated import succeeds and survives restart.

Exit: removal never deletes an active or uncommitted checkout, and filesystem
side effects cannot make durable board state silently false.

### P6-C — Engine management and pool (D2)

Files: `opencode/process-manager.ts`, `opencode/engine-registry.ts` (new), config,
`bridge/opencode/*`, `tasks/*`, command route/WS adapters, SDK client adapter,
package manifests/lock via Bun, `versions.md`, env documentation.

Implement the engine decisions in §3. Preserve the existing default shared mode
and verified 1.19.0 SDK behavior. Apply or remove dead constructor options such
as `maxRestarts`; the configured budget must match actual supervision.

Tests: exact CLI/SDK startup; healthy:false/HTML/malformed/timeout responses;
actual remote URL instead of loopback probe; authenticated engine; unavailable
engine boot with task rejection; mismatch on initial adoption and restart;
single-flight allocation; pool limit and port contention; all follow-up commands
route to the owning engine; owned crash/hang/restart exhaustion; adopted engine
survives Chorus shutdown; stale child exits do not replace a newer generation;
eight owned children stop within the shutdown budget without leaked processes.

Exit: both flag states have measured integration evidence; no global CLI drift,
silent engine routing fallback, or ignored configuration switch remains.

### P6-D — Stream recovery and concurrency qualification (D3)

Files: adapter event-stream module/tests, `bridge/opencode/*`, shared normalized
event schemas, store dedup/reconciliation hooks, existing process/E2E harness,
`scripts/phase-6-load.ts` (new), verification report.

- Continue retrying failed reopens within capped jittered backoff, cancel real
  fetches/iterators on stop, and expose connected/reconnecting/exhausted status.
- Check installed SDK cursor/resume support using its source and official docs.
  Use a verified cursor if supported. Otherwise reconcile session status,
  messages/parts, and pending permission/question requests after reconnect.
  Reconnection alone cannot recover events sent during the gap.
- Preserve source event identity in Chorus-owned validated metadata where the
  engine supplies stable IDs, and deduplicate receipts durably. Where it does
  not, reconcile absolute part content rather than append guessed delta replay.
  Scope role/part tracking by engine + session so pool streams cannot collide.
- Persist and report exhaustion to the watchdog/task state. Release abandoned
  subscriptions so a later retry can actually reconnect. Bootstrap subscriptions
  for restored sessions before accepting more prompts.

Tests: repeated failed opens then recovery; abort while fetch/read is pending;
replayed receipt dedup; role tracking across reconnect; missed completion and
approval/question recovered; interleaved directory streams; replacement engine
tracking reset; no duplicate pump, transcript, or pending request; restored board
resubscription; affected run becomes error on engine death.

Qualification: eight scripted **complete runs** across three real Git repos,
ten WS mirrors, approval/question controls during token bursts, zero index/file
collisions, converged final client/server state, and bounded snapshots. Record a
ten-minute 200-event/s run with p95 event-to-client latency ≤200 ms, RSS growth
≤50 MB, and snapshot <1 MB. Account for coalesced seq ranges correctly.

Keep the credentialed real-engine/provider test as a separate manual/nightly
qualification. Its report must label actual inference distinctly from scripted
runs. The existing optional single-prompt E2E does not prove eight real runs.

Exit: P6 functional and simulated-load gates pass; D3's credential-dependent
qualification is explicitly reported, never presented as completed by a stub.

### P7-A — Contracts, persisted requests, and device presence

Files: `packages/contracts/src/notifications.ts` (new), task/event/projector
contracts, `auth/device.ts` (new), auth routes/tickets, `ws/handler.ts`,
`ws/hub.ts`, store metadata methods, device proxy route in Next.

Define schema-derived device, subscription, push payload, and config types. Add
optional backward-compatible pending request descriptors to cards and populate
them in the shared projector from approval/question events. Clear matching
descriptors on acknowledged human resolution, abort/failure/completion, or engine
reconciliation through typed store events. Handle multiple pending request IDs
without overwriting one with another. Older snapshots/logs must still parse;
ambiguous legacy requests are reconciled before notification delivery.

Implement verified device registration and socket/ticket binding as in §3.
Do not place device identity supplied in an untrusted hello frame into presence.

Tests: schema positive/negative cases; old snapshot/event replay; descriptors
survive compaction/restart; resolution clears only the matching request; forged
device cookie; reused/expired ticket; device identity preserved via proxy cookies;
two tabs and two devices; close/heartbeat/logout/shutdown presence removal;
unauthenticated socket never suppresses push or receives state.

Exit: one authoritative request identity and a trustworthy per-device connected
predicate are available to the push module.

### P7-B — Key and subscription storage

Files: `push/config.ts`, `push/keys.ts`, `push/subscriptions.ts` (new),
`workspace/db.ts` migration and store facade, `routes/push.ts` (new),
auth public-key route, Next proxy routes, config/env/restore documentation.

Add the exact verified `web-push-neo` version with `bun add` in Serve; the inspected
upstream candidate is 0.1.2. First validate import, WebCrypto key generation,
encrypted request construction, and cancellation under the pinned Bun version.

Implement §3 key policy. Add authenticated public-key/config, idempotent
subscription upsert/replacement, and current-device unsubscribe endpoints. Use
the existing connection/writer for every mutation; new metadata writes go through
serialized store operations rather than direct writes from callbacks.

Validate payload sizes, HTTPS endpoint URLs, absence of URL credentials, and
decoded encryption key sizes. Sending to arbitrary subscription URLs is an SSRF
surface: support a documented push-provider hostname allowlist, reject private,
loopback/link-local destinations and redirects, and allow additional providers
only through operator configuration. Recheck at send time. If the selected
library cannot enforce transport policy, use its encrypted-request builder with
a controlled fetch adapter. Full endpoints and subscription keys are secrets.

Tests: migrate an actual P2/P6 database twice without data loss; concurrent key
initialization; restart retains keys; half/mismatched pairs; disabled config;
invalid subject; validated subscription/key shapes and limits; replacement and
opt-out across restart; cross-device changes rejected; all endpoints return 401
before validation for anonymous callers; SSRF/redirect/private-IP cases; backup
and offline restore preserve VAPID/subscription metadata without logging it.

Exit: keys and subscriptions are durable, authenticated, and safe to hand to the
dispatcher; disabled push starts cleanly with a useful capability response.

### P7-C — Bounded, best-effort delivery

Files: `push/dispatcher.ts`, `push/transport.ts`, `push/payload.ts` (new),
store metadata operations and commit wiring, request-resolution hooks, shutdown.

The dispatcher module exposes commit intake/start/stop; it hides scheduling,
eligibility, retries, and transport. Its push transport seam has the production
library adapter and a deterministic test adapter. The commit listener queues
work and returns immediately; no external network promise runs in the commit
queue. Database bookkeeping is serialized separately through the store.

- Trigger once per unresolved permission/question request, destination device,
  and active key set. Do not notify on token deltas or manual-review lane changes.
- Queue at most 256 jobs with four in-flight sends, five-second request timeouts,
  a five-minute notification TTL, and at most two transient retries with jitter.
  Respect Retry-After within that deadline. Make budgets configurable/validated
  only where operationally needed; overflow is counted/reported and dropped or
  reconciled later, never propagated into an agent command.
- Before every attempt, recheck that the request is pending, the device is
  opted in/offline, and the subscription/key set still matches. Cancel stale jobs
  when the request resolves, board is removed, device reconnects, or user opts out.
- Track job/dedup metadata in a bounded versioned meta namespace with TTL pruning.
  Startup reconciliation examines current pending descriptors and rebuilds
  missing eligible jobs. Duplicate provider acceptance after a crash is possible;
  use stable notification tags/topics and make no exactly-once delivery claim.
- 404/410 prune the exact obsolete subscription, never a replacement endpoint.
  429/5xx/network timeouts follow the bounded retry rule; permanent auth/key
  errors are recorded without infinite retry or automatic key rotation.
- Truncate titles and payload size. Send board/card titles, kind, opaque IDs,
  tag, and validated same-origin link; no prompt bodies, paths, permission
  arguments, code, provider keys, or raw session credentials.
- Shutdown stops intake and aborts sends within the existing global budget.
  Push failure must not reject a durable workspace write or delay approvals.

Tests with real store/HTTP/WS and fake external transport: laptop online/phone
offline selection; both devices online; multiple sockets; both request kinds;
duplicate events; two requests on one card; resolution during queued/retrying
send; late 410 after subscription replacement; stale board; opt-out/logout;
timeouts/429/500/crypto errors; queue saturation; restart dedup/reconciliation;
bounded shutdown; no unhandled rejections. Compare workspace seq/state and control
latency with delivery healthy, failing, and hanging.

Exit: permission/question handling remains functional when push is unavailable,
slow, or saturated, and only eligible devices are notified.

### P7-D — Browser opt-in, service worker, and notification focus

Files: `features/notifications/*` (new), `public/sw.js`, manifest/icons,
small settings integration in the existing header/voice controls, Next asset
headers, Serve frontend asset handling, login return handling, workspace focus
island, existing Playwright config/harness, `e2e/notifications.e2e.ts` (new), README.

Read the installed Next 16 guides before implementation. Keep pages/layouts
server-first and add client behavior only to notification settings/focus modules.
Replace or distinguish sample header notification content from real requests.

- Feature-detect secure context, service workers, PushManager, and notifications.
  Explain unsupported, disabled-server, permission-denied, and iOS Home Screen
  states without breaking normal workspace/voice use.
- Permission requests happen only on an explicit user tap. Register `/sw.js`
  at `/`, subscribe with the active public key, and synchronize through the
  authenticated proxy. Show actual device state and an opt-out control.
- Reconcile on login, worker activation, and foregrounding. Handle null
  expirationTime, scheduled renewal, missed timers while suspended, rotated
  endpoints, changed VAPID keys, revoked permission, and concurrent tabs.
  Unsubscribe before subscribing under a changed application key; show enabled
  only when browser and server registration agree.
- Worker push handler safely parses the minimal versioned payload and uses
  `event.waitUntil`. Notification click focuses/navigates an existing same-origin
  tab or opens one. Never auto-approve from a notification.
- Preserve only validated same-origin board/card return targets through login.
  Focus after sync has loaded the board/card. On a resolved/deleted target, show
  the current state or a small unavailable message without fabricating a task.
- Serve `/sw.js` as JavaScript with explicit no-store/revalidation policy, root
  scope, and CSP worker allowances. Verify headers in Next dev, built Next
  runtime, and Serve frontend serving/proxying. A 200 HTML fallback is failure.
  Do not add a fetch/offline cache handler.
- Document an operator-controlled HTTPS origin for phone testing; phone
  localhost points at the phone, not the laptop. Use a test TLS proxy if needed
  without representing Phase 8 Docker deployment as delivered.

Tests: opt-in/denied/unsupported; server failure after browser subscription;
expiration/replacement/rotation/null expiry; multi-tab single-flight renewal;
opt-out/logout; worker registration MIME/scope/headers in dev and production;
malformed payload; existing-tab and new-tab click; forbidden external return URL;
expired-login return; deleted/resolved card; keyboard/touch mobile focus.

Browser automation tests client subscription logic with controlled browser seams
and exercises real SW/notification-click handling where the browser supports it.
Do not mistake mocked permission/subscription APIs for real provider delivery.
Manual Chrome desktop/Android and iOS Safari Home Screen device delivery remain
explicit acceptance gates, including laptop tab closed and phone locked.

Exit: an offline phone receives a real approval, tapping it reaches the right
card, login recovery works, and disabling notifications stops future delivery.

## 5. Verification and release gates

Use unit tests for pure/schema/policy logic; real Git, SQLite, processes, HTTP,
SSE, and WebSockets for integration; Playwright for user actions and recovery;
real-device tests for actual push-service delivery. Fake only external engines,
push transports, telemetry, and clocks where deterministic control is needed.
Never bypass the adapter/projector by injecting prebuilt Chorus events into the
end-to-end engine fixture.

Extend the current engine fixture/harness with an OpenCode-compatible HTTP/SSE
stub emitting session/message/tool/permission/question/idle events that pass
through normalization. Validate the resulting Chorus lifecycle: attached →
queued → started → steps → approve → human reply → complete → diff. Include
reject, abort, soft/hard redirect, server/engine restart, and two-device cases.
Drive repository/board selection and approvals through visible UI controls;
API seeding is appropriate for lower-level fixtures, not the human-flow gate.

Required commands in the implementation verification record:

```text
bun run check
bun run check-types
bun test
bun run build
bun run e2e
```

Run meaningful focused suites while implementing each package; run the full
gates once the phase is ready. Add Playwright to required CI jobs with browsers
installed, deterministic fixture engine, and traces/logs on failure. Use Linux
for production security/process guarantees and a Windows job for supported
developer paths. Optional credentialed inference/device jobs are reported
separately and cannot substitute for mandatory deterministic gates.

Serve boot smoke: fresh data directory, matched local engine and intentionally
absent engine modes, `/health` 200, authenticated workspace 200, anonymous
protected routes 401, frontend functional, restart preserves boards/cards,
and SIGTERM finishes within five seconds. Verify no credential or subscription
material appears in captured logs/WS payloads; the string grep alone cannot
prove this.

| Gate | P6 acceptance | P7 acceptance |
|---|---|---|
| Authorization | Approved root/session/engine only, comprehensive route matrix | Authenticated device/key/subscription routes; signed presence; no endpoint SSRF |
| State consistency | Failed commits and crashes preserve acknowledged state and files | Request descriptors survive replay; push cannot alter workspace correctness |
| Concurrency | 10 creates, 8 complete scripted runs, 3 repos, 10 convergent clients | Multiple devices/tabs, late replacement errors, bounded delivery under saturation |
| Recovery | Create/remove intents, legacy import, engine/SSE restart, no stray owned child | Stable VAPID keys, renewal, job reconciliation, return link after login |
| Product path | Desktop/phone create → prompt → approve → done → diff | Opt in → disconnect phone → receive → tap → answer; opt out stops sends |
| Quality | All mandatory lint/log/types/tests/build/smoke gates green | Same gates plus automated notification flows and real-device evidence |

Save results in `.context/phase-6-7-verification.md` during implementation:
runtime versions, commands, counts, failures and resolutions, load measurements,
device/browser/OS versions, test origin, and any remaining explicitly accepted
qualification gap. A failed gate means the phase is not complete.

## 6. Sequencing, scope, and completion records

Order: **T0 → P6-A → P6-B → P6-C → P6-D → P6 gate → P7-A → P7-B →
P7-C → P7-D → P7 gate**. P7 client work can start against agreed contracts after
P7-A/B; final acceptance waits for the real dispatcher. Avoid concurrent writers
to store/contracts/auth/startup files.

Estimated scope: Phase 6 completion is substantial because lifecycle recovery
and the pool are missing, rather than only test additions. Treat each work package
as a reviewable change with its own behavior and tests; estimate calendar time
only after T0 identifies the actual baseline defects.

If commits are requested, preserve phase-level revertability using the required
`<type>[<AREA>]: <summary>` subjects and descriptive bodies. Do not commit, publish,
or merge from this planning request. Any later merge must use a normal merge and
wait for clean CI.

During implementation, update the base plan with the decisions above and narrow
spec clarifications. Mark D1/D2/D4/D6 closed only with tests; annotate D3 honestly
with scripted versus credentialed qualification. Split D5 so Phase 7 can close
while Phase 8 Docker and Phase 9 broader observability/soak remain open. Preserve
the historical capability baseline and update the version/restore ledgers.

## 7. Documentation used

Local product/context: `specsheet.md`, `implementation-plan.md`, `deferred.md`,
`agent-context.md`, `versions.md`, `capability-baseline.md`, `restore-runbook.md`,
and `ws-backpressure-spike.md`. The installed Next public-folder guide confirms
root URL mapping and default public-asset caching; do not assume it supplies the
specific service-worker headers required by this plan.

Context7 is not exposed in this session. Official/package-author documentation
was used as the fallback; repeat relevant version-specific checks before code.

- [OpenCode SDK](https://docs.opencode.ai/docs/sdk/): engine health/version and
  session/event interfaces; installed 1.19.0 declarations govern exact shapes.
- [OpenCode server](https://dev.opencode.ai/docs/server/): external engine auth.
- [web-push-neo source and documentation](https://github.com/ryoppippi/web-push-neo):
  runtime-neutral crypto, asynchronous key generation, abort signals, transport
  results, and the encrypted-request construction seam.
- [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps):
  service-worker setup and script response headers; local Next 16 guides take
  precedence for the implementation.
- [WebKit: iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/):
  Home Screen use and user-gesture permission requirements for the supported
  Safari 16.4 baseline. Use capability detection on newer OS versions too.
