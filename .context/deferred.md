# Chorus — Deferred work

Items consciously not done, with the reason and what would close them. Execution
detail for Phase 6 and Phase 7 is in
[phase-6-7-completion-plan.md](./phase-6-7-completion-plan.md). These statuses
reflect implementation and verification as of 2026-10-12; passing unit tests do
not substitute for the outstanding production acceptance checks.

---

## D1 — Repository authority and board creation

**Found:** Phase 6 review. **Status: implementation and focused tests complete.**

`RepositoryRegistry` now validates configured or locally picked Git roots,
canonicalizes paths, rejects unregistered roots, and replaces client supplied
checkout fields inside the serialized board creation path. Project routes use
the same registry. `repository-registry.test.ts` covers configured roots,
aliases, arbitrary paths, persisted local registrations, production behavior,
and store level board creation.

Remaining acceptance is a manual desktop folder-picker check. The eight-run
scripted qualification now passes through approval, completion, converged WebSocket
mirrors, and both diff paths; it supplies deterministic flow evidence, not browser
or real-provider acceptance.

## D2 — `OPENCODE_PER_WORKTREE`

**Found:** Phase 6 task 4. **Status: implemented; scripted load passed, deployment capacity remains open.**

The environment flag now selects the bounded `EngineRegistry`; default shared
engine behavior remains the default. Registry tests cover canonical checkout
deduplication, distinct ports, capacity limits, idle reclamation, and shutdown
during startup. Config and Serve wire the registry into directory resolution.

The scripted eight-run qualification and ten-minute 200-event/second load passed
on 2026-10-12. The load measured 42.68 MB peak RSS growth, 113 ms p95 client
latency, and a 133,813-byte final snapshot. Target-deployment capacity remains
open; keep the flag off until that gate is green in the target environment.

## D3 — Complete multi-run and inference proof

**Found:** Phase 6 concurrency exit bar. **Status: open.**

The scripted harness provisions eight isolated boards across three real Git
repositories, sends HTTP commands through the SDK-backed scripted engine, and
checks authenticated WebSocket mirrors, snapshot diffs, and session diffs. The
eight-run flow and ten-minute load passed on 2026-10-12 after startup
reconciliation was scoped to sessions attached to recoverable board work and the
store began applying its configured event snapshot interval automatically.
Credentialed real-model inference remains open.

**What closes it:** retain a separate credentialed inference run with no
shared-index collisions or missed events. Provider credentials were not
available for this execution.

## D4 — Legacy snapshot checkout collisions

**Found:** Phase 6 review. **Status: collision rejection implemented and tested.**

Legacy import validates roots and rejects two boards bound to the same checkout
before parking the source file. The store test verifies that a colliding import
fails and leaves `workspace.json` in place. The compatibility import remains
disabled by default.

## D5 — Push device acceptance, Docker, and observability

**Status: push implementation is present; device acceptance, Phase 8, and Phase
9 remain open.**

Phase 7 now includes persisted VAPID configuration, signed device identity,
device-bound WebSocket tickets, per-device connection tracking, opt-in push
subscriptions, bounded/cancellable delivery retries, push-only service-worker
handling, deep links, and recovery tests. The focused P6/P7 unit and service
tests passed. The scripted multi-client server flow now passes as recorded under
D3. No browser E2E or real Chrome/iOS device acceptance was run; browser E2E
remains unrun at the operator's request.

Docker packaging and authenticated status/observability remain Phase 8 and Phase
9 work. Their source and deployment gates are not claimed as complete here.

## D6 — Board removal and running sessions

**Found:** Phase 6 review. **Status: abort-before-removal path implemented and
unit tested.**

The task service reserves a board against new commands, aborts its active engine
session, waits for idle with a bounded timeout, and only then commits removal.
Failed abort keeps the board and checkout. Tests cover successful abort,
concurrent removal sharing one operation, and failure preservation.
