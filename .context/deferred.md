# Chorus — Deferred work

Items consciously not done, with the reason and what would close them. Each one was
found or confirmed during a phase and deliberately left, rather than forgotten.

---

## D1 — `board.create` accepts an unvalidated directory

**Found:** Phase 6 review. **Severity:** security. **Status:** open.

`POST /workspace/mutations` parses a `board.create` seed and commits it without
checking that `seed.repo.directory` (or `.worktree`) is a registered root.
`repoProjectSchema` only requires a non-empty string. Those values become the
engine's working directory, so any authenticated client can create a board
pointing at an arbitrary host path and then queue a prompt the engine will run
there — and can satisfy the `/git/*` and `/snapshots/*` root guards afterwards by
having created a board that names the path.

Phase 6 closed the adjacent hole: a prompt for a board the store does not know is
now refused instead of falling back to the caller's directory
(`board-task-service.ts`, `resolveSessionDirectory`). The create path itself is
still open.

**What closes it:** validate the seed against the P4 roots model before committing
— either require the directory to be a registered root, or introduce an explicit
root-registration step driven by the folder picker and check against it. Needs a
design decision first, because it determines how a user onboards a new repository.

**Do not:** weaken the existing P4 auth matrix, or add a fallback that treats an
unregistered path as acceptable when the engine is local.

---

## D2 — `OPENCODE_PER_WORKTREE` is not implemented

**Found:** Phase 6 task 4 asks for the flag; only the documentation exists.
**Status:** explicitly marked `NOT YET IMPLEMENTED` in `.env.example`.

Serve runs one shared engine and passes each board's directory per request, which
is correct because sessions are directory-scoped (spec §13 leaves one-engine-per-
worktree as an open question, defaulting to shared). Per-board engines would add
port allocation, per-engine readiness and liveness, ownership and idle reclamation,
and their own failure supervision.

**What closes it:** measurements first. Instrument concurrent-run count, engine
queue wait, stream latency and retry rates; implement the pool only if contention
appears near the spec's ~4-concurrent-run threshold.

---

## D3 — Load proof is simulated, not real inference

**Found:** Phase 6's done-when asks for "8 simulated concurrent runs across ≥3
repos". Provisioning and isolation are real (real git, 8 boards, 3 repos, asserted
in `worktree-concurrency.test.ts`). No real model inference runs in the suite,
because that needs configured provider credentials.

**What closes it:** the `CHORUS_E2E_AGENT=1` Playwright gate already runs one real
prompt to completion. A real load run belongs in a manual or nightly job with
credentials, asserting no shared-index collision, no lost events, correct
approvals, bounded snapshot growth, and degradation rather than silent divergence.

---

## D4 — Legacy snapshot import bypasses worktree provisioning

**Found:** Phase 6 review. **Status:** one-shot migration path only.

Boards imported from a pre-Phase-2 `workspace.json` keep whatever `repo.worktree`
the file held. If that equals `directory`, multiple boards for one repo share a
checkout until they are recreated.

**What closes it:** re-provision on import, or reject an import whose boards
collide. Low priority while `CHORUS_ENABLE_LEGACY_WORKSPACE_IMPORT` is off by
default.

---

## D6 — Removing a board does not abort its engine session

**Found:** second Phase 6 review. **Status:** partially closed.

`board.remove` now removes the board's worktree (inside the serial queue, and
never the primary checkout). It does not abort the running engine session, because
the store has no bridge and adding one would give the persistence layer a
transport dependency.

So removing a board mid-run leaves the agent working in a checkout that no longer
exists. Follow-up commands for that session are refused with
`UnknownSessionError` rather than misdirected, which is the safe half.

**What closes it:** an abort on the removal path, driven from the layer that owns
the bridge (a commit listener in `index.ts` that reacts to `board.removed`), rather
than by injecting the bridge into the store.

---

## D5 — Web push, Docker, and observability

Phases 7–9 of `.context/implementation-plan.md` are untouched. Listed here only so
this file is not mistaken for the full backlog.
