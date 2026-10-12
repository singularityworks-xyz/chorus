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

Remaining acceptance is a manual desktop folder picker check. The local full
stack qualification did not reach the approval stage, so it is not evidence of
the complete user flow.

## D2 — `OPENCODE_PER_WORKTREE`

**Found:** Phase 6 task 4. **Status: implemented; load acceptance remains open.**

The environment flag now selects the bounded `EngineRegistry`; default shared
engine behavior remains the default. Registry tests cover canonical checkout
deduplication, distinct ports, capacity limits, idle reclamation, and shutdown
during startup. Config and Serve wire the registry into directory resolution.

The qualification and sustained load gates have not passed. Keep the flag off
until those gates are green in the target deployment environment.

## D3 — Complete multi-run and inference proof

**Found:** Phase 6 concurrency exit bar. **Status: open.**

The scripted harness now provisions eight isolated boards across three real Git
repositories, sends HTTP commands through the SDK-backed scripted engine, and
checks authenticated WebSocket mirrors, snapshot diffs, and session diffs. The
current run timed out before all boards reached the approval lane. It is not
accepted as passing evidence. The ten-minute load run and credentialed real
model inference were not run.

**What closes it:** make the scripted qualification pass, run the stated ten
minute load budget, then retain a separate credentialed inference run with no
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
tests passed. No real Chrome or iOS device acceptance was run, and the full
scripted multi-client flow is still red as recorded under D3.

Docker packaging and authenticated status/observability remain Phase 8 and Phase
9 work. Their source and deployment gates are not claimed as complete here.

## D6 — Board removal and running sessions

**Found:** Phase 6 review. **Status: abort-before-removal path implemented and
unit tested.**

The task service reserves a board against new commands, aborts its active engine
session, waits for idle with a bounded timeout, and only then commits removal.
Failed abort keeps the board and checkout. Tests cover successful abort,
concurrent removal sharing one operation, and failure preservation.
