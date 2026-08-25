# Chorus — Spec Sheet

> Single source of truth for what Chorus is, how it behaves, and what is in/out of scope.
> Decisions recorded here were made deliberately (2026-08); revisit via PR that edits this file, not ad-hoc code changes.

---

## 1. Product definition

Chorus is a **self-hosted harness for driving AI coding agents** through an **infinite spatial canvas of kanban boards**.

- Each **board** targets one working copy of a repository and maps to **one opencode session**.
- Multiple boards run concurrently, so multiple repos — or isolated parallel lines of work in the *same* repo (via git worktrees) — progress simultaneously.
- One human operates the system from any device: desktop browser at the desk, phone browser away from it. The human control layer (approvals, aborts, redirects) is the product's core, not a bolt-on.

**One-line pitch:** *Your agents on a canvas; you hold the approve button.*

### Identity of the system

| Property | Value |
|---|---|
| Users per instance | 1 (multi-device, multi-session) |
| Concurrency model | Single authoritative writer (the serve process); all UIs are mirrors |
| Collaboration | None. No multiplayer, no CRDTs, no presence |
| Hosting | Laptop (localhost) **or** VPS (public URL behind TLS proxy) — identical behavior |
| Packaging | Docker / docker-compose |
| Backend runtime | Bun + Elysia (existing `apps/serve`) |
| Agent engine | OpenCode SDK (`@opencode-ai/sdk`), spawned/managed by serve |
| Durable state | SQLite (`bun:sqlite`), single file |
| Realtime transport | Native WebSocket, custom protocol (see §4). **No sync libraries** |

---

## 2. Domain model

```
Workspace (1 per instance)
 └── Board (n)            ← infinite-canvas node: position, size, view state
      ├── Repo binding    ← { projectId?, directory } resolved at creation
      ├── Worktree        ← created lazily when a 2nd board binds the same repo
      ├── Columns         ← queue | in_progress | approve | done   (fixed set)
      ├── TaskCard (n)    ← unit of requested work; belongs to exactly 1 column
      │    └── Run        ← one agent execution attempt (session-bound)
      │         └── Steps ← ordered, coalesced agent activity (tool calls,
      │                     thinking, response deltas, file edits)
      ├── ReviewMode      ← auto | manual   (manual routes idle → approve column)
      └── SessionRef      ← opencode sessionId once first prompt is queued
```

Rules:

1. **Board ↔ repo**: first board for a repo uses the primary checkout; every additional concurrent board for that repo gets a **git worktree** (`<repo>/.chorus-worktrees/<boardId>`), created before its first prompt and removable when the board closes cleanly.
2. **Board ↔ session**: a board has at most one live opencode session. A new prompt on an idle board reuses the session (continuity); a *hard redirect* forks it.
3. **Task lifecycle** (explicit, typed): `queue → in_progress → approve → done`. Transitions are produced **only** by the server projector from agent events or explicit human commands — never computed client-side.
4. **Approval is first-class**: permission requests and agent questions move the card to `approve`; nothing proceeds until answered (or aborted).
5. All cross-app payloads (opencode events, provider payloads, voice results) are normalized into **Chorus-owned types** at the boundary; external shapes never reach UI or storage directly.

---

## 3. Architecture

```
┌──────────────────────────── apps/serve (Bun, single process) ────────────────────────────┐
│                                                                                          │
│  HTTP API (Elysia)                WebSocket hub (/ws)           Projector/Store          │
│  - auth-gated commands     ◀────  - sequenced event log          - in-memory workspace    │
│  - task queue/approve/abort       - hello/sync/resume           - applies events, emits  │
│  - diff/review endpoints          - coalesced patch fan-out     - persists to SQLite     │
│         │                              ▲                             │                  │
│         ▼                              │                             ▼                  │
│  OpenCode adapter ─────────────────────┘                      bun:sqlite (WAL)           │
│  - process manager (spawn/health)                             events(seq,…)+snapshots   │
│  - per-board directory subscriptions                                          │          │
│  - event stream w/ reconnect+resume                                          backups    │
│                                                                                          │
│  Voice (Groq STT/TTS) · Web-push dispatcher (VAPID)                                      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
          ▲                                                    ▲
          │ REST + WS                                          │ REST + WS
   Desktop browser                                        Phone browser
   (Next.js app, React Flow canvas)                       (responsive layout)
```

Hard rules:

- **Single source of truth**: the store. Exactly one emit path from store → WS hub. No second state channel may exist (this deletes the current dual Spacetime/WS drift class of bugs).
- **Commands over HTTP** (request/response, idempotent by `mutationId`), **state over WS** (downstream only).
- Server-side serialization of all mutations: no read-modify-write races, ever.

---

## 4. Realtime protocol (native WS)

Transport: one `/ws` endpoint. Downstream messages carry a monotonic `seq` assigned by the store at append time.

### Handshake & resume

```jsonc
// client → server, immediately after open
{ "type": "hello", "since": 1041, "auth": "<token>" }

// server → client
{ "type": "ready", "head": 2087 }
// gap ≤ threshold (default 500):
{ "type": "event", "seq": 1042, ... }            // replay from sqlite log
// gap > threshold or unknown since:
{ "type": "snapshot", "seq": 2087, "data": {...} } // fresh full snapshot, client resets
```

- Client tracks `lastSeq`; on reconnect sends `hello(since=lastSeq)`.
- Any seq gap detected mid-stream ⇒ client issues `{type:"resync"}`; server responds with snapshot. Gaps must be impossible; detection is a safety net, not a feature.

### Live traffic

- Every persisted state change produces exactly one logged event, fanned out as a **patch** (per-board delta), never a whole-workspace snapshot.
- **Agent token streams are coalesced server-side**: step/delta patches buffer per board and flush at most every ~100 ms (configurable). Mobile radios see bursts, not per-token chatter.
- Heartbeat: server `ping` every 30 s, client must `pong` within 10 s; two missed pongs ⇒ server drops socket (client reconnects with resume). Client also detects dead sockets symmetrically.
- Backpressure: if a client's buffered send queue exceeds a high-water mark, server skips non-critical patches for that client (it will catch up via resync) instead of growing memory unboundedly.

---

## 5. Persistence (SQLite)

Single file: `<dataDir>/chorus.db`, WAL mode, `synchronous=NORMAL`.

```sql
events    (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
           board_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL /* JSON */);
snapshots (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, blob TEXT NOT NULL);
push_subs (endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, created_at INTEGER);
meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

- Write path: compute next state → `INSERT event` + commit inside an immediate transaction → **only then** swap the in-memory snapshot and assign seq for broadcast. A failed INSERT/commit leaves in-memory state untouched (candidate discarded); a crash before commit loses nothing durable. A test must cover the failed-commit path asserting memory and log stay consistent. Crash between commit and broadcast is safe (clients catch up via resume).
- **Snapshots every N events** (default 1000) or on graceful shutdown; events older than the newest snapshot are pruned.
- **Retention**: default 30 days for terminal-run detail (steps/deltas), configurable via env; card/board records persist until boards are deleted. Hard size cap (default 512 MB) triggers oldest-first compaction.
- Restore/import of `chorus.db` happens **offline**: stop accepting writes and close all connections → `wal_checkpoint(TRUNCATE)` → remove/rename stale `chorus.db-wal` / `chorus.db-shm` sidecars → replace the main database file → reopen and verify integrity. Exports use `VACUUM INTO`. Tests must prove committed WAL data survives a restore cycle. The old `workspace.json` loader runs once as a migration, then is deleted.

Explicitly fixed by this design (from the 2026 audit): silent-wipe-on-corrupt (#6), lost-update races (#7/#8), full-snapshot write amplification (#14), duplicate delivery (#12).

---

## 6. Security

The threat model is real: a public URL that spawns shell-executing agents on your machine.

1. **Token gate**: `CHORUS_TOKEN` (env, or generated on first start if absent). All HTTP routes except `GET /health` require it; a successful `POST /auth/login` exchanges it for an HttpOnly, SameSite=Strict session cookie. A newly generated token is **never emitted through the application logger** (§6.7): it is persisted to `<DATA_DIR>/chorus.token` with `0600` permissions and the bootstrap message only points the operator at that file path.
2. **WebSocket auth**: the WS upgrade is authenticated with the **same HttpOnly session cookie** (browsers attach it to same-origin upgrade requests automatically) or, for clients behind proxies that strip cookies, a short-lived single-use ticket obtained from an authenticated HTTP endpoint and presented once at upgrade. Connections failing auth are closed immediately. The server never accepts an unauthenticated socket, and browser JavaScript never needs to read or transmit `CHORUS_TOKEN` itself.
3. **CORS locked down**: same-origin only in production; explicit allowlist env for local dev ports.
4. **Path sandboxing**: every filesystem-touching operation (snapshots, diffs, worktrees, prompt file-parts) resolves against the board's registered root and rejects escapes. Absolute paths from clients are rejected unless inside a registered repo/worktree.
5. **No shell interpolation**: all git/exec invocations go through argument arrays (`execFile`-style). The current string-built `git ${args}` pattern is banned and must be removed.
6. **Rate limits**: per-IP token brute-force guard on `/auth/login`; per-client WS command rate cap.
7. Secrets (provider keys, tokens) never appear in logs, events, or the WS stream.

---

## 7. Deployment

### VPS mode (primary self-host story)

`docker compose up -d` starts:

| Service | Image/role |
|---|---|
| `chorus` | This repo's image: Bun running `apps/serve` (serves API, WS, and the built Next.js frontend) |
| `caddy` | Automatic HTTPS (Let's Encrypt) + reverse proxy to `chorus`; WS upgrade passthrough |
| *(opencode)* | Spawned by serve itself inside the container, or sidecar image — pinned version |

Volumes: `./data:/data` (SQLite db, snapshots, config). Env (all documented in `.env.example`):

```
PORT=2000                 # listen port (inside container)
CHORUS_TOKEN=             # required in production; generate if missing and log once
DATA_DIR=/data
OPENCODE_DIRECTORY=/workspaces
RETENTION_DAYS=30
DB_SIZE_CAP_MB=512
COALESCE_MS=100
VAPID_PUBLIC_KEY= / VAPID_PRIVATE_KEY=   # enables web push
GROQ_API_KEY=             # optional: voice
```

### Laptop mode

Same image, `compose.dev.yml` (or bare `bun dev`): localhost, Caddy optional, token auto-generated. Behavior identical otherwise; no "laptop-only" code paths.

### Process expectations

- Serve restart ⇒ reload snapshot + tail events; connected clients resume seamlessly. Agent sessions owned by a dead opencode process are surfaced as `error` cards on boot (never silently orphaned).
- Graceful shutdown: stop accepting, flush coalescers, write final snapshot, close sockets, SIGTERM child opencode, then exit (≤5 s budget).

---

## 8. Scale envelope (v1)

| Dimension | Budget |
|---|---|
| Boards per instance | ~20 active, soft limit; canvas virtualizes beyond viewport |
| Concurrent live agent runs | up to ~8 (opencode + provider rate limits are the real ceiling) |
| Devices connected | ≤10 simultaneous WS clients |
| Event throughput | sustained ≥200 seq'd events/s incl. coalesced deltas without UI jank |
| Workspace snapshot | stays < 1 MB serialized at these numbers |
| Event log | bounded by retention (§5), not by uptime |

Anything beyond this envelope is explicitly out of spec for v1 (see §11).

---

## 9. Client (web)

- Next.js App Router, server-first defaults; `"use client"` confined to interactive islands (canvas, kanban, composer).
- **Infinite canvas** (React Flow): pan/zoom, board nodes positioned freely; positions persist through the normal command path (debounced on drag-end).
- **Kanban lanes** render the four columns; cards show run status, elapsed, latest step; `approve` lane highlights pending permissions/questions.
- **Responsive**: usable single-column phone layout — lane list view replaces freeform canvas under `md`, approvals tappable full-screen, composer always reachable. Canvas remains desktop-primary.
- **Diff/code review**: Monaco-based inline diff per task (original vs modified), revert/unrevert actions scoped to a run.
- One sync hook (`useChorusSync`) owns the socket, resume, and seq bookkeeping; components subscribe to derived selectors. Optimistic UI allowed only for cosmetic mutations (card drag), reconciled by next patch.
- Voice: mic capture → Groq STT → prompt submit; TTS for completion/error announcements (toggleable).

---

## 10. Away-from-keyboard approvals (web push)

- VAPID-keyed Web Push; subscription stored per device (`push_subs`), renewed transparently.
- Trigger: `waiting_for_approval` or `waiting_for_question` projected onto a board while that device has no open socket.
- Payload: board title, card title, request kind — deep link opens the board focused on the approving card.
- Best-effort by design: push failure never blocks or delays the agent queue.

---

## 11. Scope

### In scope (v1)

Multi-board infinite canvas · worktree-per-extra-board isolation · queue/in_progress/approve/done flow · approvals & agent questions · abort / soft+hard redirect · session continuity & revert/unrevert · diff review (Monaco) · voice I/O (Groq) · web push approvals · SQLite persistence + retention · token auth · Docker deployment · responsive web (desktop + phone browsers)

### Out of scope (v1) — deliberate cuts

| Cut | Rationale / return path |
|---|---|
| SpacetimeDB (module + bindings) | Replaced by §4/§5; delete code, don't port it |
| Model racing | Winner-election was never implemented; revisit after core loop stabilizes. Contracts keep a placeholder enum |
| Policy engine / ArmorIQ | Zero usage today; isolate behind adapter seam if reintroduced |
| Electron desktop shell (`apps/desktop`) | Responsive web covers it; delete or freeze |
| PWA install / offline shell | Deferred; responsive web first |
| Native APNs/FCM push | Web push chosen; revisit only if iOS Safari push proves insufficient |
| Multi-user accounts / teams / sharing | Single-operator product. If teams arrive: that's the Postgres + sync-engine conversation (Zero/Electric), reopened then |
| Mobile "remote control" spacetime module | Superseded by WS + web push |

### Non-goals (permanent-ish)

Realtime multiplayer/cursors/CRDTs · offline-first writes (client is a mirror; brief offline shows stale data + resume) · public/internet-facing agent marketplace anything · Windows-native service (Docker covers it)

---

## 12. Non-functional requirements

- **Recovery point objective**: zero acknowledged state changes lost across serve crash/restart.
- **Recovery time objective**: functional UI within 5 s of process restart (snapshot load + tail).
- **Observability**: structured logs (existing logger), one `/health` (liveness) and one `/bridge/status`-style diagnostic endpoint (opencode connectivity, head seq, client count, watchdog stats). No PII/secrets in logs.
- **Testability**: protocol handler, store/projector, retention/compaction, and auth are unit-tested; a Playwright e2e smoke (create board → queue prompt against fixture repo → approve → done) gates releases.
- **TypeScript discipline**: no `as any`; statuses/event types as shared unions; external payloads validated at the boundary (zod schemas in `packages/contracts`).

---

## 13. Open questions (tracked, not blocking)

1. Opencode process model at the upper scale end: one shared managed instance vs one-per-worktree spawn pool (decide when >4 concurrent runs show contention).
2. Snapshot format versioning for future imports/exports (workspace portability between instances).
3. Whether voice TTS announcements deserve their own event class in the log or stay ephemeral (leaning ephemeral).

---

*Changelog*
- 2026-08: initial spec. Decisions: native-WS-over-sync-libraries, SQLite-over-Postgres, token auth, Docker packaging, worktree-per-extra-board, medium envelope, web push for approvals, racing/policy/electron/spacetime cut.
