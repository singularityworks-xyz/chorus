# Chorus — Implementation Plan (specsheet → reality)

> Executes `.context/specsheet.md` against the post-cleanup codebase (`cleanup/spec-alignment`).
> Each phase ships independently testable value and ends green. Order = dependency order.
> Companion documents: `specsheet.md` (what/why), `cleanup-plan.md` (done), this file (how/when).
> Last reviewed: 2026-10 (amendment pass: Phase 0 added, RCE hotfix pulled forward,
> SDK upgrade mandated, per-phase deliverables + unit/integration tests, voice/auth clarified).

---

## Stack pins (verified 2026-10)

| Tech | Current | Pin / action |
|---|---|---|
| Bun | runtime 1.4.0, `packageManager: bun@1.3.11` | **fix mismatch in Phase 0**: bump `packageManager` to `bun@1.4.x` so CI (`bun-version-file: package.json`) and local runtime agree. Until then every phase records `bun --version` in its verification log |
| Elysia | 1.4.28 | keep; WS hub uses native `Bun.serve` websockets via Elysia `.ws()` — verify `drain`/`send(buffered)` semantics against 1.4 docs when touching backpressure |
| Next.js | 16.2.2 (App Router, Turbopack) | **read `apps/web/node_modules/next/dist/docs/` before any app-router work** — repo AGENTS.md warns of breaking changes vs training data |
| React | 19.2.4 (+ React Compiler via babel plugin) | keep; `useEffectEvent` already in use in provider |
| Zod | 4.3.6 | keep; all new schemas go through it |
| SQLite | `bun:sqlite` (built-in) | `Database`, cached `db.query()`, `db.transaction(...).immediate`, `PRAGMA journal_mode = WAL` — confirmed current API |
| Web Push | *(new dep)* | `web-push-neo` — TS/ESM, Web Crypto + fetch, works on Bun (classic `web-push` is Node-crypto-bound); aes128gcm only, fine for Safari 16+ |
| OpenCode SDK | lockfile resolves **1.3.15** (`^1.3.13`); npm latest **1.18.x** | **mandatory upgrade in Phase 6 (task 5 rewritten)**: bump `@opencode-ai/sdk` to the current 1.18.x **in lockstep** with the spawned `opencode serve` binary (same version both sides). The adapter's direct re-export of SDK `Event`/`SessionStatus` types means any shape drift leaks into the projector — diff the SDK changelog, update the normalization layer, extend `event-stream.test.ts`. Never bump the SDK without pinning the binary to match |

Standing rules per AGENTS.md: no `as any`, shared enums/unions over loose strings, validate cross-app payloads with schemas, `bun run check` + `check-types` + tests after every phase.

**Cross-cutting log gate (active from Phase 0 onward):** `scripts/check-log-gate.sh` (new in Phase 0, owner: whoever executes Phase 0) greps for `console.log`/`logger.*` calls whose string literal contains `token`, `password`, `secret`, or `key=` and exits non-zero on any hit. Wired into `bun run check` (or lefthook pre-push if `check` cannot host it — record the choice in the Phase 0 commit body). Every phase's Verify section includes "log gate passes"; Phase 9 re-sweeps all call sites added in Phases 3–8.

---

## Pre-implementation decisions (answer before writing Phase 1 code)

These affect API shapes defined in Phase 1. Record answers in this section before proceeding.

1. **Store emit type**: `applyMutation` must return `{ boardId: string | null, event: WorkspaceEvent }` (a per-board delta), not a full `WorkspaceSnapshot`. The hub fans out this delta; components subscribe to board-scoped selectors. This is the contract between Phase 2 and Phase 3 — decide now.

2. **Mutation ID deduplication across restart**: use the `meta` table with a rolling window — `INSERT OR REPLACE INTO meta(key, value)` where key is `mut:<mutationId>` and value is the timestamp. A boot-time prune removes entries older than 24 h. Simple, no new table.

3. **Session cookie expiry**: 30 days, `Max-Age=2592000`, `Secure` (enforced in production), `HttpOnly`, `SameSite=Strict`. A `POST /auth/logout` clears the cookie. Re-login after expiry shows the login screen — not a silent redirect loop.

4. **`CHORUS_TOKEN` boot behavior**: two modes, no shared code path.
   - **Laptop/dev** (`NODE_ENV !== "production"`): auto-generate 32-byte hex token, write to `<DATA_DIR>/chorus.token` (mode `0600`), log the file path only.
   - **Production** (`NODE_ENV=production`): if `CHORUS_TOKEN` env is unset or empty, print an actionable error (`CHORUS_TOKEN must be set in production. See .env.example.`) and `process.exit(1)`. Never auto-generate silently in prod.

5. **OpenCode version lockstep**: the `@opencode-ai/sdk` version in `packages/opencode-adapter/package.json` and the `opencode` binary version spawned by `process-manager.ts` must be identical (record both in `.context/versions.md`, new in Phase 0, updated by Phase 6). SDK-before-binary or binary-before-SDK skew is a release-blocking mismatch — the Phase 6 integration test asserts version equality at boot.

---

## Phase exit bar (applies to every phase, P0–P9)

A phase is not done until **all** of these hold. Phase-specific gates add to this list, never replace it.

1. `bun run check` (incl. log gate) green.
2. `bun run check-types` green (root + all workspaces).
3. `bun test` green — no skipped-without-reason tests; every new behavior has a unit test, every cross-boundary behavior has an integration test (see per-phase lists).
4. Both builds green where touched (`next build` for web, serve typecheck/build).
5. Boot smoke: `OPENCODE_AUTO_START=false PORT=2100` serve boots, `GET /health` 200, frontend served at `/`.
6. Commit per repo format (`<type>[<AREA>]: <summary>` + body paragraph) on the phase branch; body notes test evidence and any deferred risk.

---

## Phase 0 — Cleanup finish, baselines, RCE hotfix

**Goal:** close out the assumed-done `cleanup/spec-alignment`, freeze measurable baselines, and kill the live RCE class **before** any phase exposes the server to a network. No VPS/LAN exposure until Phase 4 completes; localhost-only until then.

Tasks
1. Finish cleanup leftovers: `git rm` empty stubs `packages/agent-events/`, `packages/policy-engine/`, `packages/spacetime-bindings/`, `apps/desktop/` (verify zero importers first per cleanup-plan ground rule 2); remove stale `ARMORIQ_*` from `apps/serve/.env.example`, `"policy_blocked"` from `packages/voice/src/contracts.ts`, `@chorus/policy-engine` path from `apps/serve/tsconfig.json`; fix `AGENTS.md` realtime-layer line (spacetimedb → native WS event log per spec §11 cut).
2. Fix `packageManager` Bun pin mismatch (`bun@1.3.11` → `bun@1.4.x`); create `.context/versions.md` recording bun / elysia / next / SDK / opencode-binary versions.
3. **RCE hotfix (pulled forward from Phase 4.7 — non-negotiable):** rewrite `apps/serve/src/snapshot/index.ts` git calls from string `exec(\`git ${args}\`)` to `execFile` arg arrays; same for `projects/auth-login.ts` (`bash -lc "cd ..."`) and every other `rg 'exec\(' apps/serve/src` hit. Add minimal `resolveInside(root, p)` util now (full sandbox coverage stays in Phase 4); apply it to snapshot/diff/restore paths in this phase.
4. Baselines: record green `check-types` / `check` / `bun test` / `next build` output, capability inventory (`/tmp/baseline-routes.txt`, `/tmp/baseline-ws.txt`, `/tmp/baseline-pages.txt` per cleanup-plan Phase 0), and `bun --version`.
5. Create `scripts/check-log-gate.sh` + wire into `bun run check` (or pre-push; record choice in commit body). Create root `.env.example` skeleton listing all spec env vars (values filled in Phase 8).

Files: deletions above, `apps/serve/src/snapshot/index.ts`, `apps/serve/src/projects/auth-login.ts`, `apps/serve/src/paths/sandbox.ts` (new), `scripts/check-log-gate.sh` (new), `.env.example` (new, root), `.context/versions.md` (new), `AGENTS.md` (1 line)
Deliverables: clean tree (no empty stub packages); RCE class dead; version + capability baselines committed under `.context/`; log gate enforced.
Unit tests: `sandbox.test.ts` — escape attempts (`../`, absolute, symlink-adjacent) rejected, in-root paths pass; exec-audit test asserting zero `exec(` string-interpolation call sites (grep-based, fails if one is reintroduced).
Integration tests: boot smoke on `PORT=2100` (`/health` 200, `/` serves frontend); `hash: "x; touch /tmp/pwned"` restore attempt → clean arg error, file absent.
Done when: `rg -il 'spacetimedb|@chorus/spacetime|armoriq|policy-engine' --glob '!*.md' --glob '!.context/*'` empty; `rg 'exec\(' apps/serve/src` shows zero shell-string invocations; exit-bar §Phase-exit-bar holds.

---

## Phase 1 — Event vocabulary & protocol contracts

**Goal:** one typed language for the log, the wire, and the UI — defined once, before either side exists.

Tasks
1. In `packages/contracts`: define `WorkspaceEvent` as a zod discriminated union covering board lifecycle (`board.created/moved/removed/selected/review_mode/model_set`), card lifecycle (`card.created→queued→started→waiting_for_approval→completed/failed`), run/step events (`run.started`, `step.upserted`, `step.delta_appended`), session events (`session.attached/idle/error/timeout`).
2. Define wire envelopes: `ClientHello {since}` (auth rides the session cookie on the WS upgrade, or a short-lived single-use ticket query param for cookie-stripping proxies — never a raw token in message bodies), `ServerReady {head}`, `SequencedEvent {seq, ts, boardId, event}`, `SnapshotMsg {seq, data}`, `ResyncReq`. Note: `SequencedEvent` carries `boardId` so the hub can fan out per-board deltas without re-diffing the full snapshot. Export inferred types.
3. Version field on snapshot blob (`v: 1`) for future migrations.
4. **Pure projector helper** in `packages/contracts/src/projector.ts`: export `applyEventToBoard(board: WorkspaceBoard, event: WorkspaceEvent): WorkspaceBoard` as a pure function with no side effects. Both `apps/serve/src/workspace/projector.ts` and the web provider reducer must import and call this function — never duplicate the logic. This is the single mitigation for server/client projector drift.
5. **Mutation→Event mapping**: define `MutationToEventMap` (or inline in the store handler) that enforces the 1-mutation-to-1-event contract. Every `WorkspaceMutation` variant maps to exactly one `WorkspaceEvent` variant. Document the table in a comment at the top of `store.ts`.

Files: `packages/contracts/src/events.ts` (new), `packages/contracts/src/protocol.ts` (new), `packages/contracts/src/projector.ts` (new), `packages/contracts/src/index.ts` (re-export all)
Deliverables: versioned (`v: 1`) typed vocabulary importable by both apps with zero cross-app dependency; 1-mutation-to-1-event table documented.
Unit tests: `packages/contracts/src/events.test.ts` — every `WorkspaceEvent` variant round-trips through its zod schema (parse → serialize → parse); negative cases (unknown discriminator, missing required field) rejected. `projector.test.ts` — `applyEventToBoard` covers **all** event types incl. out-of-order/no-op inputs (e.g. `step.delta_appended` with no matching step is a no-op, never throws); purity assertion (input object deep-frozen, output is a new reference).
Integration tests: both apps import the new exports and `bun run check-types` passes at root (contract-consumption gate — catches breaking schema edits in CI rather than at runtime).
Done when: both apps can import the full vocabulary without depending on each other; zero duplicate projector logic exists across the repo (`rg 'applyAgentEventToBoard' apps/web/src apps/serve/src` shows exactly one definition site in contracts plus call sites).

---

## Phase 2 — SQLite event-log store (replaces workspace.json)

**Goal:** durable, single-writer, append-only state core. Fixes audit #6/#7/#8/#14.

Tasks
1. New `apps/serve/src/workspace/db.ts`: open `<DATA_DIR>/chorus.db`, WAL, `synchronous=NORMAL`, tables `events/snapshots/push_subs/meta` exactly per spec §5. Cached prepared statements only. **File permissions**: after opening (or creating) `chorus.db`, call `fs.chmod(dbPath, 0o600)` — the DB contains the entire application state and must not be world-readable.
2. Rewrite `WorkspaceStore` around a **serial async queue** implemented as a single private `#queue: Promise<void>` field. Every mutation and `applyAgentEvent` chains onto this field: `this.#queue = this.#queue.then(() => doWork()).catch(() => {})`. This is the only safe pattern — never use `Promise.all` or fire-and-forget for state-mutating work. Each task: compute next state → `INSERT event` + commit inside `db.transaction().immediate` → **only on successful commit** swap in-memory snapshot and assign seq → resolve with `{ boardId, event: WorkspaceEvent }`. Failed INSERT/commit discards the candidate; memory never runs ahead of the durable log.
3. `applyMutation` return type is `{ boardId: string | null, event: WorkspaceEvent }` (per pre-implementation decision #1). Routes and the hub consume this; routes no longer broadcast directly.
4. **MutationId deduplication across restart**: before applying any mutation, check `meta` table for key `mut:<mutationId>`. If found, return early with the current snapshot (idempotent). On successful commit, `INSERT OR REPLACE INTO meta(key, value) VALUES ('mut:<mutationId>', <ts>)` inside the same transaction. Boot-time prune: `DELETE FROM meta WHERE key LIKE 'mut:%' AND CAST(value AS INTEGER) < <now - 86400000>`.
5. Snapshotting: every N=1000 events or on graceful shutdown write `snapshots(seq,blob)` (bounded ≤5s, awaited before exit — test asserts persistence completes within budget). **Pruning tail window is zero**: `DELETE FROM events WHERE seq < (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT 1)`. Retention job (default 30d terminal-run detail, size cap 512 MB) runs at boot + hourly.
6. **Graceful shutdown drain**: expose `store.drain(): Promise<void>` that returns when `#queue` resolves. Shutdown sequence in `index.ts` must `await store.drain()` before writing the final snapshot, then run `PRAGMA wal_checkpoint(TRUNCATE)` after the snapshot write so a cold copy of `chorus.db` is always a complete backup.
7. Offline restore/import procedure: close connections → `wal_checkpoint(TRUNCATE)` → clear stale `-wal`/`-shm` sidecars → replace db file → reopen + integrity check. Export via `VACUUM INTO`. Test: committed-WAL data survives a restore cycle.
8. Migration: if legacy `workspace.json` exists, import as initial snapshot event, rename to `workspace.json.imported`. The migration code path is **guarded by a feature flag** and will be deleted after the first production migration confirms success (schedule deletion in the commit body). Corrupt JSON must **fail loudly** (exit non-zero with the path in the message) — never silently reset to empty (that bug dies here).

Files: `workspace/db.ts` (new), `workspace/store.ts` (rewrite), `index.ts` (wiring, add `store.drain()` to shutdown)
Deliverables: serve runs entirely off SQLite; corrupt-input-loud-failure; documented restore/import runbook (added to README or `.context/restore-runbook.md`).
Unit tests (`workspace/store.test.ts`, extend): concurrent mutation storm (≥200 parallel mutations) ends serialized and complete (final revision exact, zero lost/dup); **failed-commit path** (injected commit failure) keeps memory and log consistent; mutationId dedup (same id twice → second is idempotent no-op); boot prune deletes only `mut:` entries older than 24 h; retention/compaction math (terminal-run detail older than 30 d compacted, card/board rows kept; size-cap triggers oldest-first); migration path (valid JSON imports, corrupt JSON throws); `chorus.db` mode `0600` assertion.
Integration tests (`workspace/store-restart.test.ts`, new): kill -9 mid-write (spawned child process) then boot recovers to last committed event with zero acknowledged-write loss; mutationId dedup **across restart** (write mut, restart process, re-send same mutationId → idempotent); restore/import WAL-survival (committed WAL data present after checkpoint → replace → reopen + `PRAGMA integrity_check`); bounded shutdown (`drain()` + snapshot flush ≤5 s wall-clock).
Done when: serve runs entirely off SQLite; no `writeFile(workspace.json)` anywhere (`rg 'workspace\.json' apps/serve/src` shows only the flagged migration path); log gate passes.

---

## Phase 3 — WebSocket hub v2 + single emit path

**Goal:** spec §4 protocol live server-side; every downstream byte originates from the store's commit point.

**Day-1 spike (required before committing to hub design):** prototype Elysia `.ws()` backpressure. Verify: what does `ws.send()` return when the buffer is full? Does `drain` fire reliably? What is the high-water mark? Record findings in a comment at the top of `ws/hub.ts` before writing the production implementation. Do not proceed past the spike without this data.

Tasks
1. Hub module owning: client registry, `hello(since)` handshake → replay from `events` table or fresh snapshot (>500 gap), live fan-out of `SequencedEvent` patches. **Fan-out is per-board delta**: the store emits `{ boardId, event }` (Phase 2 return type); the hub serializes and sends only to clients subscribed to that board (or all clients if `boardId` is null/workspace-scoped).
2. Coalescer: per-board buffer flushed every `COALESCE_MS=100` for step/delta-class events. **Control events bypass coalescing** — define `isControlEvent(event: WorkspaceEvent): boolean` exported from `packages/contracts/src/protocol.ts`. Approvals, state transitions, abort, session events are always control events and are sent immediately.
3. **VIEWPORT_SYNC passthrough**: VIEWPORT_SYNC messages from a client are re-broadcast to all other connected clients immediately (no seq, no store write, not persisted). This is the only message type that still uses a passthrough pattern. Document it explicitly in the hub with a comment.
4. Heartbeat: server ping 30s, drop after 2 missed pongs; client-triggered resync handled. Track last-pong timestamp per client; a background interval checks and drops stale sockets.
5. Backpressure: track per-client buffered bytes using data from the spike. Above high-water mark, switch client to "critical-only" (control events only) until drained (Elysia `drain` callback resets the flag). Client catches up via resume on reconnect. This prevents unbounded memory growth under slow mobile connections.
6. Delete `broadcastRaw(createWorkspaceMessage(...))` from routes/ws handler/index.ts — routes now return HTTP results and the store emit drives all client state. Zero direct `ws.send` calls outside the hub.

Files: `ws/hub.ts` (new), delete/replace `events/broadcaster.ts`, edits in `routes/*`, `tasks/*`, `index.ts`
Deliverables: spike findings comment atop `ws/hub.ts`; single-emit-path invariant (`rg` clean); per-board delta fan-out; documented VIEWPORT_SYNC exception.
Unit tests (`ws/hub.test.ts`, `ws/coalescer.test.ts`, new): `hello(since)` with gap ≤500 replays exact missing seqs in order; gap >500 (or unknown `since`) yields a snapshot; `isControlEvent` classifies every `WorkspaceEvent` variant (approval/transition/abort/session = control, step deltas = coalescible); coalescer flushes step/delta bursts at ≤10 msg/s while passing control events through unbuffered; heartbeat tracker drops clients after 2 missed pongs; backpressure flag flips to critical-only above HWM and resets on `drain`.
Integration tests (`ws/hub.integration.test.ts`, new, real sockets against test server): fake opencode burst of 500 events → two clients receive identical ordered seq streams; reconnect with `since` replays the exact gap with zero dup/miss; VIEWPORT_SYNC round-trips to the other client and leaves the `events` table untouched; a `card.waiting_for_approval` emitted mid-burst arrives within one RTT (control bypass under load); unauthenticated handshake is rejected (after Phase 4 this asserts 4401; before Phase 4 it asserts the hook point exists — re-run post-P4).
Done when: `rg 'ws\.send\|broadcastRaw' apps/serve/src` finds zero hits outside `ws/hub.ts`.

---

## Phase 4 — Security hardening

**Goal:** spec §6 completely enforced. The RCE class already died in Phase 0; this phase completes auth, transport, and abuse guards. **No network exposure beyond localhost until this phase is green.**

Tasks
1. **Token generation**: `CHORUS_TOKEN` auto-generation (laptop mode only, per pre-implementation decision #4) uses `crypto.getRandomValues(new Uint8Array(32))` encoded as hex — 256 bits of entropy. UUID v4 (122 bits) and `Math.random` are banned for this purpose. Write to `<DATA_DIR>/chorus.token` with `fs.chmod(path, 0o600)` immediately after write. Log the file path only, never the token value.
2. Auth middleware: `POST /auth/login` validates `CHORUS_TOKEN` body field → issues HttpOnly, SameSite=Strict, **Secure** (in production), `Max-Age=2592000` (30 days) signed cookie. Signing uses Web Crypto HMAC-SHA256; the signing key is derived from `CHORUS_TOKEN` via `HKDF-SHA256` with label `"chorus-session"`. **All routes except `GET /health` and `POST /auth/login` require a valid cookie — including `/voice/*`, `/projects/*`, `/workspace`, `/tasks/*`, `/snapshots/*`, `/git/*`.** `POST /auth/logout` clears the cookie.
3. **WS ticket single-use enforcement**: `GET /auth/ws-ticket` (authenticated) generates a random 16-byte hex token, stores it in the `meta` table as `wst:<ticket>` with a 5-minute expiry timestamp. On WS upgrade, the ticket is looked up, verified not-expired, and immediately deleted (single-use). Unauthenticated or already-used tickets close the socket with code 4401.
4. **Content-Security-Policy header**: add `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:` to the static-file serving middleware in `web-frontend.ts`. Adjust `unsafe-inline` only as needed by Next.js build output — do not use `unsafe-eval`.
5. CORS: production = same-origin only. Dev allowlist via `CORS_ALLOWED_ORIGINS=http://localhost:3000` (comma-separated). Add this var to `.env.example` with a note that it is dev-only and must not be set in production.
6. Path sandbox util (`resolveInside(root, p)`): full coverage — snapshots, diffs, worktrees, prompt file-parts; absolute paths rejected unless under a registered root. (Hotfix in Phase 0 covered snapshot/diff/restore; this task extends to worktrees + file-parts and adds the audit test.)
7. Re-audit `snapshot/index.ts` + `rg 'exec\(' apps/serve/src`: confirm zero shell-string invocations remain post-Phase-0; any new call site must use `execFile` arg arrays. (Verification task, not new code, unless the audit finds a regression.)
8. Rate limits: login brute-force (per-IP sliding window, max 10 attempts per 10 min, 429 response) + WS command cap per client (max 60 commands/min, drop with close 4429 if exceeded).

Files: `serve/auth/*` (new), `routes/*` guards, `snapshot/index.ts`, `projects/*`, `ws/hub.ts`, `web-frontend.ts`
Deliverables: token lifecycle (laptop-autogen + prod-hard-fail); cookie auth on every route incl. voice; single-use WS tickets; CSP; CORS lockdown; sandbox on all fs paths; rate limits. This phase unlocks LAN/VPS exposure.
Unit tests (`serve/auth/*.test.ts`, new): HMAC sign/verify round-trip; forged/tampered cookie rejected; expired cookie rejected; ticket single-use (consume twice → second fails); ticket expiry (5-min TTL enforced with fake clock); brute-force window (11th attempt in 10 min → 429, window reset after); WS command cap (61st command/min → 4429); `resolveInside` rejects `../`, absolute-outside-root, and prefix-sibling (`/data2` vs `/data`) paths.
Integration tests (`serve/auth-matrix.test.ts`, new, real HTTP+WS): curl matrix — unauthenticated hits to `/workspace`, `/tasks`, `/voice/tts`, `/projects`, `/snapshots/diff` → 401; valid login → cookie → 200; forged cookie → 401; expired WS ticket → 4401; reused WS ticket → 4401; `hash: "x; touch /tmp/pwned"` → clean arg error, file absent; CSP header present on all responses; `chorus.db` + `chorus.token` mode `0600`; brute-force guard triggers after 10 failed logins.
Done when: audit findings #3/#4/#5 are demonstrably dead; `rg 'exec(' apps/serve/src` shows zero shell-string invocations; the auth matrix passes end-to-end.

---

## Phase 5 — Client sync rewrite (`useChorusSync`) + patch-based provider

**Goal:** replace ad-hoc socket; UI consumes sequenced patches; phone survives backgrounding.

Tasks
1. `features/sync/use-chorus-sync.ts`: connect → hello(lastSeq from `localStorage`) → apply snapshot/replay → live; exp backoff reconnect (250ms→30s w/ jitter); seq-gap ⇒ resync; `visibilitychange` triggers immediate hello on foreground; `online`/`offline` listeners. **`lastSeq` persistence**: store in `localStorage` under key `chorus:lastSeq`. On hard refresh the client sends the persisted seq and receives only the gap rather than a full snapshot. Guard against stale/corrupt values: if `localStorage` read throws or returns NaN, default to `0` (forces snapshot).
2. **Reconnect idempotency**: `visibilitychange` and `online` may fire simultaneously (e.g., device wakes from sleep). The hook must enforce only one pending `hello` in-flight at a time — use a `reconnecting: boolean` ref; if true, skip the duplicate trigger.
3. **401 loop guard**: on receiving a 401 from any HTTP call or a `close(4401)` from the WS, stop reconnecting immediately, clear `lastSeq` from `localStorage`, and emit an `AUTH_EXPIRED` event that the root layout converts to a login screen redirect. Do not retry on 401 — it will not resolve without user action.
4. Provider refactor: reducer applying `WorkspaceEvent`s to boards using the shared `applyEventToBoard` from `packages/contracts` (Phase 1 deliverable). **Optimistic drag mechanism**: maintain a `pendingDrags: Map<boardId, { position, mutationId }>` ref. On drag-end, apply the position locally and fire the mutation HTTP call. When a `SequencedEvent` arrives whose `mutationId` matches a pending drag, remove it from the map. If the server patch contradicts the pending drag, the server wins. On timeout (5 s without matching seq), clear the optimistic state. This prevents canvas flicker without risking stale positions.
5. Login screen/token entry UX (Phase 4 cookie flow) + 401 handling in `chorus-serve` proxy lib.
6. Mobile responsive pass: lane-list layout < md, full-screen approval cards, sticky composer (spec §9).
7. Read Next.js 16 bundled docs before touching app router files; keep server-first boundaries; `"use client"` only where interactivity requires it.

Files: `web/src/features/sync/*` (new), `workspace/provider.tsx`, `lib/chorus-serve.ts`, kanban/canvas selectors
Deliverables: `useChorusSync` owning all socket/resume/seq bookkeeping; patch-based provider with zero `setBoards`/`setSnapshot` full-replace paths; login screen; phone-usable approval flow.
Unit tests (vitest/bun-test under `apps/web`, new `features/sync/*.test.ts`): backoff schedule (250 ms → 30 s cap, jitter bounds); single-in-flight reconnect guard (simultaneous `visibilitychange`+`online` → exactly one `hello`); corrupt `lastSeq` (`NaN`, throw, negative) → defaults to `0`; 401 path clears `lastSeq` and emits `AUTH_EXPIRED` exactly once (no retry loop); optimistic-drag map (matching `mutationId` clears entry; contradictory server patch wins; 5 s timeout clears stale entry).
Integration tests (Playwright, new `e2e/sync.spec.ts` — first Playwright spec in repo): kill/restart serve mid-session → client auto-recovers with zero missed cards; airplane-mode toggle on mobile emulation → catch-up on reconnect; two browsers stay consistent after the same burst; hard-refresh sends `lastSeq` from localStorage (assert WS `hello` frame); 401 stops reconnect and shows login screen (not a redirect loop).
Done when: old socket code deleted; no component fetches workspace over HTTP polling; `rg 'setBoards\|setSnapshot' web/src` finds zero hits.

---

## Phase 6 — Worktree-per-board + opencode process fixes + SDK upgrade

**Goal:** spec §2 topology rules; multi-repo concurrency that actually works; SDK/binary brought to current.

Tasks
1. **Boot-time dangling worktree cleanup**: on serve start, enumerate `<repo>/.chorus-worktrees/` directories for all repos in the current snapshot. Remove any whose `boardId` subdirectory does not correspond to a board in the snapshot (orphans from crashed serve). Log each removal. Run before accepting any connections.
2. Project manager: create/remove git worktrees (arg-array git only) at `<repo>/.chorus-worktrees/<boardId>`; idempotent (`git worktree list` check before create); **cleanup is always within the store's serial queue** — worktree creation is awaited inside the board-create mutation handler, not fired as an async side effect after. This prevents a race where two simultaneous board-creates for the same repo both try to create the same worktree path.
3. Board-task-service: bind board → resolved directory (worktree-aware); **session-reuse fix**: reuse an existing opencode session only when `board.repo.directory === session.workingDirectory` (exact path match including worktree path). If the directory differs, fork a new session. Never reuse across directories.
4. Process manager: port from env (kill hardcoded 4096), readiness gate poll on `/health`-equivalent before first use, real liveness check (verify opencode identity endpoint), optional per-worktree spawn behind `OPENCODE_PER_WORKTREE=true` config flag (spec §13 open question — implement flag, default `false` = shared). **Pin the spawned binary version and record it in `.context/versions.md` alongside the SDK version (pre-implementation decision #5).**
5. **SDK upgrade (mandatory, replaces the old 1.3.x re-verify line):** bump `@opencode-ai/sdk` to current 1.18.x via `bun add` in `packages/opencode-adapter` (never hand-edit the dep list); diff `Event`/`SessionStatus`/permission/question payload shapes against the 1.3.x baseline and update the adapter normalization layer so only Chorus-owned types cross the boundary; add reconnect-with-cursor if the new SDK offers resume, else wrap with retry+backfill from the bridge (fixes audit #13); extend `event-stream.test.ts` for reconnect/resume. Record the new SDK + binary versions in `.context/versions.md`.

Verify: two boards same repo → isolated worktrees visible in `git worktree list`; parallel prompts run without index lock errors; process restart mid-prompt → surfaced as `error` card on reboot (never silently orphaned); boot with a dangling worktree dir → logged removal, clean start; concurrent board-create stress test (10 simultaneous creates for the same repo) → no duplicate worktree paths.
Files: `projects/*` (worktree manager), `tasks/board-task-service.ts`, `opencode/process-manager.ts`, `packages/opencode-adapter/**`, `.context/versions.md`
Deliverables: worktree-per-extra-board isolation; dir-exact session reuse; env-port + readiness + liveness; SDK 1.18.x + binary lockstep recorded.
Unit tests: worktree path computation (`<repo>/.chorus-worktrees/<boardId>`, idempotency when `git worktree list` already contains it); session-reuse predicate (same dir → reuse; worktree dir → fork; unrelated dir → fork); `resolveInside` applied to worktree roots; adapter normalization (new SDK event shapes map to Chorus-owned types; unknown future variant → logged + skipped, never stored raw); boot version assertion (SDK version === binary version, mismatch → loud boot error).
Integration tests: two boards on the same fixture repo → `git worktree list` shows two isolated entries; parallel prompts (≥4) run without git index-lock errors; kill opencode mid-prompt → reboot surfaces an `error` card (never silently orphaned); seed a dangling worktree dir → boot logs its removal and starts clean; 10 simultaneous board-creates for one repo → exactly one worktree per board, no dup paths; SDK event-burst replay against the stub (Phase 9 stub drafts the sequence here if not yet written).
Done when: 8 simulated concurrent runs across ≥3 repos hold §8 budgets locally.

---

## Phase 7 — Web push approvals

**Goal:** spec §10 end-to-end. Voice I/O stays in scope for v1 (Groq STT/TTS already wired): this phase additionally puts the voice HTTP routes under the Phase 4 cookie guard verification if not already covered, and adds the push opt-in UI next to the existing voice settings.

Tasks
1. Dep: `web-push-neo` (`bun add`, never hand-edit); VAPID keypair generated into `meta` table on first boot; `VAPID_PUBLIC_KEY` exposed via authenticated `GET /auth/vapid-key` endpoint.
2. **Service worker scope**: register `sw.js` at the root scope (`/`). Verify the file is served correctly by Next.js 16 App Router — static files in `public/` are served at `/`, but confirm with a build test that `navigator.serviceWorker.register('/sw.js')` resolves in both dev (Turbopack) and the production static build. Document any workaround needed.
3. Web: minimal service worker (`public/sw.js`) — `push` event shows notification, `notificationclick` → deep link `/board/<id>?card=<cardId>` and focuses the existing tab if open; subscription client hook + opt-in UI.
4. **Push subscription expiry**: when subscribing, check `PushSubscription.expirationTime`. If non-null, schedule a silent re-subscribe before expiry (`setTimeout` on the client). On `visibilitychange` to visible, compare the stored endpoint with `registration.pushManager.getSubscription()` — if different or null, re-subscribe and PATCH the server. This handles browser-rotated subscription keys transparently.
5. Serve: on projection to `waiting_for_approval` or `waiting_for_question`, notify subscribed devices without an open socket (hub knows which clients are connected). **Push send is fully wrapped in try/catch**: 410 responses prune the `push_subs` row; all other errors are logged and swallowed — push failure never throws or delays the agent queue.
6. `push_subs` table wired; subscription sent on opt-in and renewed per task 4.

Verify: manual device test Chrome desktop + iOS Safari 16.4+ (installed-to-home-screen caveat documented in README); unit-test payload build + 410 pruning; sub expiry handling (mock `expirationTime` to 1 s and verify re-subscribe fires).
Files: `apps/serve/src/push/*` (new), `apps/web/public/sw.js` (new), `apps/web/src/features/notifications/*` (new), `routes/auth.ts` (vapid-key endpoint)
Deliverables: end-to-end approval push (serve → device → deep link); expiry-tolerant subscriptions; push-never-blocks guarantee.
Unit tests (serve): payload builder (board title, card title, kind, deep link — no secrets/PII beyond titles); 410 response prunes the `push_subs` row; any other send error is swallowed (queue proceeds, error logged); VAPID keypair generated once (second boot reuses, never rotates silently). Unit tests (web): expiry scheduler (mock `expirationTime` = now+1 s → re-subscribe fires); endpoint-change detector (stored ≠ live → PATCH sent).
Integration tests: project to `waiting_for_approval` with (a) device socket open → no push sent, (b) socket closed → push sent to subscribed endpoint; push-failure injection (mock 500) → agent queue still advances, UI unaffected; `sw.js` resolves at `/sw.js` in both `next dev` and `next build` output (build test asserting registration path).
Done when: approval arrives on phone while laptop tab closed; tapping opens the right board/card; push failure does not surface as an error to the agent or UI.

---

## Phase 8 — Docker deployment

**Goal:** spec §7 — VPS story first-class, laptop story identical image.

Tasks
1. Multi-stage `Dockerfile`: `oven/bun` base → `bun install --production` → build web (static output consumed by serve) → slim runtime image. **Non-root user**: create `chorus` user/group in the image. **Volume permissions**: entrypoint script runs `chown -R chorus:chorus /data` before starting serve — required because Docker volumes are created as root by default and serve will fail to write `chorus.db` otherwise. Add `HEALTHCHECK CMD curl -f http://localhost:${PORT:-2000}/health || exit 1`.
2. `compose.yaml` profiles: `prod` (chorus + caddy w/ LE TLS, volume `./data`), `dev` (chorus only). Root `.env.example` (started in Phase 0) completed here to match the spec env list exactly, each var annotated **required** or **optional** with the consequence of omitting it:
   `PORT` (optional, default 2000) · `CHORUS_TOKEN` (**required in prod** — hard boot failure if unset; laptop/dev auto-generates) · `DATA_DIR` (optional, default `/data`) · `OPENCODE_DIRECTORY` (optional) · `OPENCODE_PER_WORKTREE` (optional, default false) · `RETENTION_DAYS` (optional, default 30) · `DB_SIZE_CAP_MB` (optional, default 512) · `COALESCE_MS` (optional, default 100) · `CORS_ALLOWED_ORIGINS` (dev-only, must not be set in prod) · `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (optional — push disabled if absent) · `GROQ_API_KEY` (optional — voice STT/TTS 503 if absent). Delete the stale `ARMORIQ_*` lines (Phase 0 if not already done).
3. Graceful shutdown flush verified inside container: `docker stop` sends SIGTERM → serve drains queue, writes final snapshot, checkpoints WAL, exits within 5s. Test by running `docker stop --time=10 <container>` and verifying state is intact on restart.
4. Docs: laptop mode (`bun dev`) + VPS quickstart in README. Include a one-liner for generating `CHORUS_TOKEN`: `openssl rand -hex 32`.

Verify: fresh-clone `docker compose --profile prod up` on a VPS → HTTPS URL, login gate, prompt round-trip; container restart → state intact; `chorus.db` and `chorus.token` owned by `chorus` user, mode `0600`; SIGTERM → clean exit ≤5s.
Files: `Dockerfile` (new), `compose.yaml` (new, profiles `prod`/`dev`), `Caddyfile` (new, via caddy service), `docker/entrypoint.sh` (new), `.env.example` (completed), `README.md` (quickstarts)
Deliverables: stranger-can-self-host packaging for both VPS (TLS) and laptop (local) from README alone.
Unit tests: env parsing (missing `CHORUS_TOKEN` + `NODE_ENV=production` → boot error naming `.env.example`; all-optional-absent → sane defaults incl. `PORT=2000`, `COALESCE_MS=100`); compose file schema check (both profiles define `./data` volume, prod includes caddy with WS upgrade passthrough).
Integration tests (run where Docker is available; otherwise release-gate manual with checklist): fresh-clone `compose --profile prod up` → HTTPS reachable, login gate enforced, one prompt round-trip completes; `docker stop --time=10` → clean exit ≤5 s → restart shows intact state (board + card present); `chorus.db`/`chorus.token` owned by `chorus`, mode `0600`.
Done when: a stranger can self-host from README alone.

---

## Phase 9 — Observability, e2e gates, scale validation

**Goal:** spec §12 non-functionals proven, not assumed.

Tasks
1. `/status` (authenticated, same session cookie as all other routes): head seq, connected clients, watchdog stats, db size, coalescer depth. Structured-log sweep: run `rg 'token|password|secret|key=' apps/serve/src` and audit every hit — no secrets in log output. Ensure the structured log grep gate (introduced in Phase 0, active since Phase 2 scope) covers all new log call sites added in Phases 3–8.
2. **Playwright e2e stub contract**: the scripted opencode stub must emit a complete, realistic `WorkspaceEvent` sequence: `session.attached` → `card.queued` → `card.started` → `step.upserted` (tool call) → `card.waiting_for_approval` → (approve) → `step.upserted` (result) → `card.completed`. A stub that skips events will pass tests while hiding projector bugs. The stub contract is a Phase 9 deliverable — write it first, then the test.
3. Playwright e2e (`playwright.config.*` new, first config in repo): fixture repo + stub → create board → prompt → approve → done → diff view. Wire into CI as release gate; non-zero exit fails the release. Test must also cover: kill/restart serve mid-run → client recovers; two browsers receive identical state.
4. **Load harness CI gate**: the load harness script (200 ev/s, 8 concurrent runs × 10 min) runs in CI (nightly or on release branches) with hard budget assertions: exit non-zero if p95 event-to-client latency > 200ms or RSS memory growth > 50MB over the run. Committed load report under `.context/load-report.md` is the human-readable artifact; the CI gate is the automated guard.
5. Retention/compaction soak test; backup doc (`sqlite3 .backup` / litestream pointer).

Files: `routes/status.ts` (new, authenticated), `playwright.config.ts` (new), `e2e/*.spec.ts` (new), `scripts/load-harness.*` (new), `.context/load-report.md` (new), `.github/workflows/ci.yml` (e2e + nightly load jobs), backup doc in README
Deliverables: authenticated `/status`; Playwright stub contract + release-gate suite; load harness with hard budgets; committed load report; backup/restore doc.
Unit tests: `/status` shape (all fields present, authenticated; unauthenticated → 401); stub-contract validator (the stub's emitted sequence parses against every `WorkspaceEvent` schema in order — a stub that skips an event fails the validator before any e2e runs); retention math at scale (soak fixture asserts bounded `events` table after simulated 30 d + cap enforcement).
Integration tests: full e2e (stub) — create board → prompt → approve → done → diff view renders; kill/restart serve mid-run → client recovers with zero missed cards; two browsers receive identical state; load harness — 200 ev/s sustained, 8 concurrent stub runs × 10 min, p95 event-to-client latency ≤200 ms, RSS growth ≤50 MB (non-zero exit otherwise); backup round-trip (`VACUUM INTO` export → offline restore → integrity + data present).
Done when: CI runs lint+types+unit+e2e+load-gate; load report committed under `.context/`; `/status` endpoint returns without exposing secrets.

---

## Dependency graph

```
P0 ──▶ P1 ──▶ P2 ──▶ P3 ──▶ P5 ──▶ P9
             ▲    ▲         ▲
P4 ─────────┘    └── P7    │
P6 ◀─ (after P2)     │    │
             └─────────┴────┘
P8 ◀─ P4 (deploy requires auth done); overlaps P5–P7
```

P0 precedes everything (RCE hotfix + baselines gate all networked testing).
Notes on parallelism:
- P6 can run alongside P3/P5 but P5's integration test requires P6 complete (worktree paths are part of board identity in multi-board state).
- P9 Playwright e2e requires P5 + P6 + P7 all complete (approval leg tests push notification).
- P8 scaffolding (Dockerfile skeleton, compose file) can start alongside P7 but final verification requires P4 (auth) done.

## Sequencing & effort estimate

| Phase | Size | Risk |
|---|---|---|
| 0 baselines + RCE hotfix | S | low (no behavior change except exec path + loud-fail migration guard) |
| 1 contracts | S | low |
| 2 sqlite store | M | med-high (correctness core; serial queue must be exact) |
| 3 ws hub v2 | M | med-high (protocol + backpressure spike) |
| 4 security | M | med |
| 5 client sync | L | high (UX regression surface; optimistic drag + 401 guard) |
| 6 worktree/process + SDK upgrade | M-L | med (SDK 1.3→1.18 shape drift is the wildcard; pin binary in lockstep) |
| 7 web push | S-M | low-med |
| 8 docker | S | low |
| 9 obs/e2e/load | M | low |

Suggested cadence: land P0–P4 as one reviewable arc ("backend core"), then P5 alone (biggest blast radius), then P6–P9.

## Explicit risks

1. **Next.js 16 drift**: bundled docs are canonical; do not trust memorized app-router APIs.
2. **Elysia WS backpressure**: spike on Day 1 of Phase 3 — verify `drain` callback and `send()` return semantics before committing to the high-water-mark design. Do not skip the spike.
3. **iOS Safari web push** requires installed-to-home-screen; spec accepted this (web-push chosen over APNs anyway). Document prominently in README.
4. **Projector parity**: mitigated by `applyEventToBoard` pure helper in `packages/contracts` (Phase 1 deliverable). If this helper is not in contracts, any divergence between server and client reducers is invisible until a client renders wrong state. Do not skip this task.
5. **Serial queue correctness**: the `#queue = #queue.then(...)` pattern must be applied to every mutation entry point — `applyMutation`, `applyAgentEvent`, `updateBoardSession`. A single unguarded direct call reintroduces races. Code review must check this mechanically.
6. **Worktree creation race**: worktree create must be inside the serial queue (Phase 6, task 2). If it slips outside, concurrent board-creates silently corrupt the worktree list. Flag this in the PR review checklist.
7. **OpenCode SDK 1.3→1.18 drift**: event/permission/question payload shapes may have changed across ~15 minors; the adapter's type re-exports propagate breakage silently. Mitigated by lockstep binary pin (decision #5), changelog diff, normalization-layer update, and extended `event-stream.test.ts` — all Phase 6 exit gates, none optional.
8. **RCE regression**: any future `exec(` string-interpolation reintroduces the Phase 0 kill class. Mitigated by the grep-based unit test (Phase 0) that fails CI on reintroduction. Do not delete or weaken that test.

---

## Amendment changelog

- 2026-10: Phase 0 added (cleanup finish, Bun pin fix, `.context/versions.md`, RCE hotfix pulled forward from P4.7 with `resolveInside` seed, baselines, log-gate script + owner, root `.env.example` skeleton). SDK pin updated (1.3.13 → upgrade mandate to 1.18.x with binary lockstep; decision #5; P6.5 rewritten; risk #7). P4 rescoped (auth/transport/abuse; RCE now verify-only; voice routes explicitly in cookie guard). P8.2 env table completed. Per-phase Deliverables + Unit + Integration test lists added (P0–P9). Phase-exit bar added. `AGENTS.md` realtime-line fix assigned to P0. Amendment review owners: plan author + one reviewer before P0 starts.
