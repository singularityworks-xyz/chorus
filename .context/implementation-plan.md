# Chorus — Implementation Plan (specsheet → reality)

> Executes `.context/specsheet.md` against the post-cleanup codebase (`cleanup/spec-alignment`).
> Each phase ships independently testable value and ends green. Order = dependency order.
> Companion documents: `specsheet.md` (what/why), `cleanup-plan.md` (done), this file (how/when).

---

## Stack pins (verified 2026-08)

| Tech | Current | Pin / action |
|---|---|---|
| Bun | runtime 1.4.0, `packageManager: bun@1.3.11` | bump pin to `1.4.x`; CI reads `bun-version-file` so one line fixes both |
| Elysia | 1.4.28 | keep; WS hub uses native `Bun.serve` websockets via Elysia `.ws()` — verify `drain`/`send(buffered)` semantics against 1.4 docs when touching backpressure |
| Next.js | 16.2.2 (App Router, Turbopack) | **read `apps/web/node_modules/next/dist/docs/` before any app-router work** — repo AGENTS.md warns of breaking changes vs training data |
| React | 19.2.4 (+ React Compiler via babel plugin) | keep; `useEffectEvent` already in use in provider |
| Zod | 4.3.6 | keep; all new schemas go through it |
| SQLite | `bun:sqlite` (built-in) | `Database`, cached `db.query()`, `db.transaction(...).immediate`, `PRAGMA journal_mode = WAL` — confirmed current API |
| Web Push | *(new dep)* | `web-push-neo` — TS/ESM, Web Crypto + fetch, works on Bun (classic `web-push` is Node-crypto-bound); aes128gcm only, fine for Safari 16+ |
| OpenCode SDK | 1.3.13 | adapter isolates it; re-verify event-stream shape against SDK changelog in Phase 6 |

Standing rules per AGENTS.md: no `as any`, shared enums/unions over loose strings, validate cross-app payloads with schemas, `bun run check` + `check-types` + tests after every phase.

---

## Phase 1 — Event vocabulary & protocol contracts

**Goal:** one typed language for the log, the wire, and the UI — defined once, before either side exists.

Tasks
1. In `packages/contracts`: define `WorkspaceEvent` as a zod discriminated union covering board lifecycle (`board.created/moved/removed/selected/review_mode/model_set`), card lifecycle (steal `card.created→queued→started→waiting_for_approval→completed/failed` naming from deleted agent-events), run/step events (`run.started`, `step.upserted`, `step.delta_appended`), session events (`session.attached/idle/error/timeout`).
2. Define wire envelopes: `ClientHello {since}` (auth rides the session cookie on the WS upgrade, or a short-lived single-use ticket query param for cookie-stripping proxies — never a raw token in message bodies), `ServerReady {head}`, `SequencedEvent {seq, ts, event}`, `SnapshotMsg {seq, data}`, `ResyncReq`. Export inferred types.
3. Version field on snapshot blob (`v: 1`) for future migrations.

Files: `packages/contracts/src/index.ts` (+ new `events.ts`, `protocol.ts`)
Verify: unit tests round-tripping every variant; type exports consumed by a throwaway import in serve/web.
Done when: both apps can import the full vocabulary without depending on each other.

## Phase 2 — SQLite event-log store (replaces workspace.json)

**Goal:** durable, single-writer, append-only state core. Fixes audit #6/#7/#8/#14.

Tasks
1. New `apps/serve/src/workspace/db.ts`: open `<DATA_DIR>/chorus.db`, WAL, `synchronous=NORMAL`, tables `events/snapshots/push_subs/meta` exactly per spec §5. Cached prepared statements only.
2. Rewrite `WorkspaceStore` around an **ordered async queue**: every mutation and `applyAgentEvent` enqueues onto one serial task chain (no interleaved RMW possible). Each entry: compute next state → `INSERT event` + commit inside `db.transaction().immediate` → **only on successful commit** swap in-memory snapshot and assign seq → resolve with `{snapshot?, event}`. Failed INSERT/commit discards the candidate; memory never runs ahead of the durable log.
3. Snapshotting: every N=1000 events or on graceful shutdown write `snapshots(seq,blob)` (bounded ≤5s, awaited before exit — test asserts persistence completes within budget); prune events `< newest snapshot seq - tail window`; retention job (default 30d terminal-run detail, size cap 512 MB) runs at boot + hourly.
4. Offline restore/import procedure: close connections → `wal_checkpoint(TRUNCATE)` → clear stale `-wal`/`-shm` sidecars → replace db file → reopen + integrity check. Export via `VACUUM INTO`. Test: committed-WAL data survives a restore cycle.
4. Migration: if legacy `workspace.json` exists, import as initial snapshot, rename to `.imported`.
5. Keep public store API surface (`getSnapshot/getBoard/applyMutation/updateBoardSession/...`) so routes/services change minimally.

Files: `workspace/db.ts` (new), `workspace/store.ts` (rewrite), `index.ts` (wiring)
Verify: unit tests — concurrent mutation storm ends serialized & complete; kill -9 mid-write then boot recovers to last committed event; **failed-commit path keeps memory and log consistent**; migration path; retention compaction math; restore/import WAL-survival; bounded shutdown (snapshot flush ≤5s).
Done when: serve runs entirely off SQLite; no `writeFile(workspace.json)` anywhere.

## Phase 3 — WebSocket hub v2 + single emit path

**Goal:** spec §4 protocol live server-side; every downstream byte originates from the store's commit point.

Tasks
1. Hub module owning: client registry, `hello(since)` handshake → replay from `events` table or fresh snapshot (>500 gap), live fan-out of `SequencedEvent` patches (per-board delta computed by projector, not whole snapshots).
2. Coalescer: per-board buffer flushed every `COALESCE_MS=100` for step/delta-class events; control events (approvals, state moves) bypass coalescing.
3. Heartbeat: server ping 30s, drop after 2 missed pongs; client-triggered resync handled.
4. Backpressure: track per-client buffered bytes; above high-water mark switch client to "critical-only" until drained (client catches up via resume).
5. Delete `broadcastRaw(createWorkspaceMessage(...))` from routes/ws handler/index.ts — routes now return results and the store emit drives clients. VIEWPORT_SYNC becomes ephemeral presence lane (not sequenced, not persisted).

Files: `ws/hub.ts` (new), delete/replace `events/broadcaster.ts`, edits in `routes/*`, `tasks/*`
Verify: integration test — fake opencode event burst of 500 events → clients see ordered seqs, ≤10 messages/sec after coalescing, reconnect with `since` replays exact gap; two clients never diverge.
Done when: grep finds zero direct `ws.send` outside the hub.

## Phase 4 — Security hardening

**Goal:** spec §6 completely enforced. Do before any deployment work.

Tasks
1. Auth middleware: `POST /auth/login` exchanges `CHORUS_TOKEN` → HttpOnly SameSite=Strict signed cookie (Web Crypto HMAC; no new dep). All routes except `/health` + `/auth/login` require it. Token auto-generated on first boot and persisted to `<DATA_DIR>/chorus.token` with `0600` perms; the bootstrap log line names the file path only — **the token value is never logged**.
2. WS auth: upgrade authenticated by the session cookie, or a single-use short-lived ticket (`GET /auth/ws-ticket`, ~5 min TTL) for cookie-stripping proxies; unauthenticated sockets closed immediately (close 4401).
3. CORS: production = same-origin only; dev allowlist env.
4. Path sandbox util (`resolveInside(root, p)`): applied to snapshots, diffs, worktrees, prompt file-parts; absolute paths rejected unless under a registered root.
5. Rewrite `snapshot/index.ts` git calls from string `exec` to `execFile` arg arrays (removes RCE class). Same for any other exec site.
6. Rate limits: login brute-force (per-IP sliding window) + WS command cap per client.

Files: `serve/auth/*` (new), `routes/*` guards, `snapshot/index.ts`, `projects/*`, ws hub
Verify: curl matrix — unauthenticated route hits → 401; forged cookie → 401; `hash: "x; touch /tmp/pwned"` restore attempt → clean arg error, file absent; sandbox escape attempts logged+rejected.
Done when: audit findings #3/#4/#5 are demonstrably dead.

## Phase 5 — Client sync rewrite (`useChorusSync`) + patch-based provider

**Goal:** replace ad-hoc socket; UI consumes sequenced patches; phone survives backgrounding.

Tasks
1. `features/sync/use-chorus-sync.ts`: connect → hello(lastSeq) → apply snapshot/replay → live; exp backoff reconnect (250ms→30s w/ jitter); seq-gap ⇒ resync; visibilitychange triggers immediate hello on foreground; online/offline listeners.
2. Provider refactor: reducer applying `WorkspaceEvent`s to boards (mirrors server projector semantics); optimistic cosmetic layer only for drags, reconciled by next patch; remove wholesale `setBoards(snapshot)` path.
3. Login screen/token entry UX (Phase 4 cookie flow) + 401 handling in `chorus-serve` proxy lib.
4. Mobile responsive pass: lane-list layout < md, full-screen approval cards, sticky composer (spec §9).
5. Read Next 16 bundled docs before touching app router files; keep server-first boundaries.

Files: `web/src/features/sync/*` (new), `workspace/provider.tsx`, `lib/chorus-serve.ts`, kanban/canvas selectors
Verify: Playwright — kill/restart serve mid-session → client auto-recovers with zero missed cards; airplane-mode toggle on mobile emulation → catch-up; two browsers stay consistent.
Done when: old socket code deleted; no component fetches workspace over HTTP polling.

## Phase 6 — Worktree-per-board + opencode process fixes

**Goal:** spec §2 topology rules; multi-repo concurrency that actually works.

Tasks
1. Project manager: create/remove git worktrees (arg-array git only) at `<repo>/.chorus-worktrees/<boardId>`; idempotent; cleanup on board close.
2. Board-task-service: bind board → resolved directory (worktree-aware); fix session-reuse-across-directories bug (reuse only when directory matches, else fork/create).
3. Process manager: port from env (kill hardcoded 4096), readiness gate poll on `/health`-equivalent before first use, real liveness check (verify opencode identity endpoint), optional per-worktree spawn behind config flag (spec §13 open question — implement flag, default shared).
4. Re-verify adapter event-stream against SDK 1.3.x changelog: add reconnect w/ cursor if SDK offers resume; else wrap with retry+backfill from bridge (fixes audit #13).

Verify: two boards same repo → isolated worktrees, parallel prompts, no index lock contention; process restart mid-prompt → surfaced as error card on reboot.
Done when: 8 simulated concurrent runs across ≥3 repos hold §8 budgets locally.

## Phase 7 — Web push approvals

**Goal:** spec §10 end-to-end.

Tasks
1. Dep: `web-push-neo`; VAPID keypair generated into `meta` on first boot; `VAPID_PUBLIC_KEY` exposed via authenticated endpoint.
2. Web: minimal service worker (`public/sw.js`) — pushshow notification, click → deep link `/board/<id>?card=<cardId>`; subscription client hook + opt-in UI.
3. Serve: on projection to `waiting_for_approval|question`, notify subscribed devices without an open socket (hub knows); best-effort, failures prune stale endpoints (410).
4. `push_subs` table wired; renewal on focus.

Verify: manual device test Chrome desktop + iOS Safari (16.4+ installed-PWA caveat documented); unit-test payload build + 410 pruning.
Done when: approval arrives on phone while laptop tab closed; tapping opens the right board/card.

## Phase 8 — Docker deployment

**Goal:** spec §7 — VPS story first-class.

Tasks
1. Multi-stage `Dockerfile`: oven/bun base → `bun install --production` → build web (static output consumed by serve) → slim runtime image, non-root user, HEALTHCHECK.
2. `compose.yaml` profiles: `prod` (chorus + caddy w/ LE TLS, volume `./data`), `dev` (chorus only). `.env.example` matching spec env list exactly.
3. Graceful shutdown flush verified inside container (SIGTERM → final snapshot ≤5s).
4. Docs: laptop mode (`bun dev`) + VPS quickstart in README.

Verify: fresh-clone `docker compose --profile prod up` on a VPS → HTTPS URL, login gate, prompt round-trip; container restart → state intact.
Done when: a stranger can self-host from README alone.

## Phase 9 — Observability, e2e gates, scale validation

**Goal:** spec §12 non-functionals proven, not assumed.

Tasks
1. `/status` (authenticated): head seq, connected clients, watchdog stats, db size, coalescer depth. Structured-log sweep: no secrets/PII, consistent fields.
2. Playwright e2e (dep already present): fixture repo + scripted opencode stub → create board → prompt → approve → done → diff view. Wire into CI as release gate; a non-zero exit fails the phase/release.
3. Load harness script: simulate 200 ev/s + 8 concurrent runs × 10 min against local stack; assert latency/memory budgets from §8.
4. Retention/compaction soak test; backup doc (`sqlite3 .backup` / litestream pointer).

Done when: CI runs lint+types+unit+e2e; load report committed under `.context/`.

---

## Dependency graph

```
P1 ──▶ P2 ──▶ P3 ──▶ P5 ──▶ P9
            ▲    ▲
P4 ─────────┘    └── P7 (push needs auth+hub)
P6 ◀─ (after P2; independent of P3/P5)
P8 ◀─ P4 (deploy requires auth done); overlaps P5–P7
```

Parallelizable: P6 alongside P3/P5; P8 scaffolding alongside P7.

## Sequencing & effort estimate

| Phase | Size | Risk |
|---|---|---|
| 1 contracts | S | low |
| 2 sqlite store | M | med (correctness core) |
| 3 ws hub v2 | M | med-high (protocol) |
| 4 security | M | med |
| 5 client sync | L | high (UX regression surface) |
| 6 worktree/process | M | med |
| 7 web push | S-M | low-med |
| 8 docker | S | low |
| 9 obs/e2e/load | M | low |

Suggested cadence: land P1–P4 as one reviewable arc ("backend core"), then P5 alone (biggest blast radius), then P6–P9.

## Explicit risks

1. **Next.js 16 drift**: bundled docs are canonical; do not trust memorized app-router APIs.
2. **Elysia WS internals** (drain/backpressure callbacks): prototype backpressure early in P3 spike before committing to design.
3. **iOS Safari web push** requires installed-to-home-screen; spec accepted this (web-push chosen over APNs anyway).
4. **Projector parity**: server reducer and client reducer must interpret identical event semantics — mitigate by keeping interpretation logic in `packages/contracts` helpers where pure.
