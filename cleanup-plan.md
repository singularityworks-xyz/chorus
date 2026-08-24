# Cleanup Plan — Spec Alignment Pass

> Companion to `specsheet.md`. Goal: remove everything §11 cut, plus verified-dead code,
> **without losing any in-spec functionality**. Every phase ends green or we stop and investigate.
> Execution order = risk order: zero-consumer deletions first, wired-feature removals last.

---

## Ground rules (apply to every phase)

1. **Work on a branch**: `cleanup/spec-alignment`. One commit per phase (format: `chore[CLEANUP]: ...` + body).
2. **Re-verify consumers immediately before each deletion** — drift happens between planning and executing. A target with any new importer gets pulled from that phase, not force-deleted.
3. **Deletion ≠ silent**: every intentional capability loss (racing, policy endpoints) is listed in §"Intentional losses" below and called out in the commit body.
4. **Untouchables**: PostHog wiring and the Next.js proxy-route layer (deferred decision D), `help/page.tsx` content, everything in `packages/contracts`, `packages/monaco`, `packages/voice`.

---

## Phase 0 — Baseline & safety nets (no deletions)

Purpose: know exactly what "unchanged" means.

- [ ] `bun install` clean; record lockfile state
- [ ] Green baseline recorded for: `bun run check-types`, `bun run check`, `bun test`, `next build` (web), `bun build`/typecheck (serve)
- [ ] **Capability inventory snapshot** — enumerate before touching anything:
  - [ ] Serve HTTP routes: grep `.get(`/`.post(`/`.ws(` registrations in `apps/serve/src/routes/*` + `index.ts` → save list to `/tmp/baseline-routes.txt`
  - [ ] WS message types: export values of `WS_MESSAGE_TYPE` / `WS_RESPONSE_TYPE` (`apps/serve/src/ws/types.ts`) → `/tmp/baseline-ws.txt`
  - [ ] Web pages: `app/*/page.tsx` list → `/tmp/baseline-pages.txt`
- [ ] Boot smoke: start serve with `OPENCODE_AUTO_START=false PORT=2100`, expect `/health` 200 and frontend served at `/`
- [ ] Manual smoke checklist (5 min): canvas renders boards · create/open board via folder picker · kanban lanes visible · command palette opens · prompt composer works against fixture dir

## Phase 1 — Zero-consumer dead code (lowest risk)

Targets (re-grep importers immediately before `git rm`):

| Target | Must-be-empty grep |
|---|---|
| `packages/agent-events/` | `@chorus/agent-events` across repo |
| `apps/web/src/features/workspace/db.ts` | `workspace/db` |
| `apps/serve/src/bridge/voice/service-manual-test.ts` | `service-manual-test` |
| `tsconfig.tsbuildinfo` | tracked-file check |

Also: add `*.tsbuildinfo` to `.gitignore`; drop `dexie` from `apps/web/package.json`.

**Verify:** all four greps empty · `bun install` · check-types · `bun test` · `next build` · boot smoke from Phase 0 passes.

## Phase 2 — SpacetimeDB removal

Order matters here — one small *code edit* accompanies the deletions:

1. Edit `apps/web/src/features/workspace/provider.tsx`: remove `useSpacetimeConnection`/`useKanbanSync` usage and the column-merge effect (lines ~84–105). **Behavior-neutral by proof**: the merged tables don't exist server-side, so `kanbanSync.columns` was permanently `null` and the effect already no-op'd. Kanban data flows only through the WS `workspace.updated` path — unchanged.
2. `git rm` `apps/web/src/features/spacetime/` (4 files), `packages/spacetime-bindings/`, `spacetime/`.
3. Drop `@chorus/spacetime` from `apps/web/package.json`; `bun install`.
4. Sweep: `rg -i spacetimedb|@chorus/spacetime` → allowed remnants: none in code (docs/history only).

**Verify:** check-types · `bun test` · `next build` · boot smoke · **manual**: canvas + kanban render identically to Phase 0 smoke, board create → columns replace → card appears (proves the non-Spacetime path intact).

## Phase 3 — Model racing removal (intentional feature loss, spec §11)

| Deletion | Notes |
|---|---|
| `packages/opencode-adapter/src/features/race/race-manager.ts` | + its export in adapter `index.ts` |
| `bridge.startRace` / `bridge.promptRace` / `get races` in `bridge.ts` | callers: ws handler, routes only |
| `TASK_RACE` case + schema in `ws/handler.ts`; type consts in `ws/types.ts` | update `types.test.ts`/`handler.test.ts`: delete race cases, all other cases stay green |
| `POST /tasks/:sessionID/race` in `routes/index.ts` | |

Keep: any race-related enum in `contracts` (spec-mandated placeholder).

**Verify:** `rg -il race` → only contracts placeholder (+ prose in help/docs, update copy if stale) · full test suite · route diff vs baseline shows exactly one removal: `POST /tasks/:sessionID/race` · boot smoke.

## Phase 4 — Policy engine / ArmorIQ removal (intentional, spec §11)

1. `git rm packages/policy-engine apps/serve/src/bridge/policy apps/serve/src/routes/policy.ts`
2. Remove `.use(policyRoutes)` from `apps/serve/src/index.ts`
3. Strip `ARMORIQ_*` vars from `config/env.ts` (fix any env test asserting them); drop `@armoriq/sdk` from serve deps

**Verify:** `rg -i armoriq|policy-engine` empty · serve tests green · route diff shows exactly the policy removals · boot smoke.

## Phase 5 — Electron desktop removal *(conditional: awaiting delete-vs-freeze call)*

1. `git rm -r apps/desktop`
2. Root `package.json`: drop `electron`, `electron-builder`, `electron-vite`
3. `turbo.json`: drop desktop pipeline entries; `ci.yml`: drop desktop job(s); sweep READMEs/docs mentions

**Verify:** `rg -il electron` → only historical changelogs · `turbo run build` + `check-types` cover exactly web+serve+packages · CI workflow YAML parses (`bunx actionlint` if available).

## Phase 6 — Web dependency slimming

Remove from `apps/web/package.json` (after re-running the import greps):

| Dep | Proof required |
|---|---|
| `@opencode-ai/sdk` | `rg "@opencode-ai/sdk" apps/web/src` empty (adapter owns SDK access) |
| `monaco-editor`, `@codingame/monaco-vscode-editor-api`, `vscode` aliases | zero direct imports under `apps/web/src` (they live correctly in `packages/monaco`) |
| `shadcn` | confirm no script invokes `shadcn` binary directly |

**Verify:** `bun install` (lockfile shrinks) · `next build` succeeds — this is the real test that Monaco reaches the web app transitively through `packages/monaco` · diff UI smoke: open a task with file edits, Monaco renders.

## Phase 7 — Trivial leftovers + final battery

- [ ] Delete `app/test-ui/page.tsx`, `app/background/page.tsx` (first confirm `BackgroundCanvas`'s primary consumer is the main page)
- [ ] Full battery: `bun run check` · `check-types` · `bun test` · both builds · boot smoke
- [ ] **Diffs vs Phase 0 baselines**, expected result:
  - Routes: minus `race`, minus policy set — nothing else
  - WS types: minus `TASK_RACE` pair — nothing else
  - Pages: minus `test-ui`, `background` — nothing else
  - Capability inventory: identical except racing + policy (documented losses)
- [ ] Bundle-size sanity on web build (should shrink slightly post-Dexie/spacetime)

---

## Intentional functionality losses (complete list)

1. Model racing (start/prompt race sessions) — spec cut; winner-election never existed
2. Policy evaluation endpoints + ArmorIQ hooks — spec cut; zero production usage
3. Desktop (Electron) shell — spec cut; responsive web covers it
*(Nothing else loses behavior. All other deletions have zero runtime consumers.)*

## In-spec capabilities preserved (verification owners)

| Capability | Verified by |
|---|---|
| Canvas pan/zoom, board create/move/remove/select | Phase 0 vs Phase 7 manual smoke |
| Queue prompt → agent runs → steps stream | manual smoke w/ fixture repo |
| Approvals, questions, abort, soft/hard redirect | serve unit tests + smoke |
| Revert/unrevert, diff views (Monaco) | Phase 6 diff smoke |
| Voice STT/TTS loop | voice service tests (untouched module) |
| Projects/folder picker, model picker, palette | manual smoke |
| Kanban local undo/redo (`use-kanban-history`) | untouched; compile + smoke |
