# Chorus — Version Ledger

> Recorded in Phase 0 as the baseline. Any version change updates this file in
> the same commit as the dependency change. Phase 6 enforces SDK ↔ binary
> lockstep (see pre-implementation decision #5 in `implementation-plan.md`).

## Baseline — 2026-10-01 (Phase 0)

| Component | Version | Source |
|---|---|---|
| Bun runtime | 1.4.0 | `bun --version` |
| `packageManager` pin | `bun@1.4.0` | `package.json` (was `bun@1.3.11`, mismatched the runtime — fixed in Phase 0) |
| Elysia | ^1.4.28 | `apps/serve/package.json` |
| Next.js | ^16.2.2 | `apps/web/package.json` |
| React / React DOM | ^19.2.4 | `apps/web/package.json` |
| Zod | 4.3.6 | root + workspace dev deps |
| @opencode-ai/sdk | 1.3.15 (resolved from `^1.3.13`) | `packages/opencode-adapter` |
| opencode CLI | 1.18.29 | `opencode --version` |
| TypeScript | ^6.0.2 | root dev deps |

## Phase 6 — SDK ↔ binary lockstep (2026-10-03)

Pre-implementation decision #5: the `@opencode-ai/sdk` version and the spawned
`opencode` binary version must be identical. The SDK is now pinned to an exact
version rather than a range, because `^1.18.29` resolves to 1.18.34 and the boot
assertion would fail on a fresh install.

| Component | Version | Source |
|---|---|---|
| @opencode-ai/sdk | **1.18.29** (exact pin, no caret) | `packages/opencode-adapter/package.json` |
| opencode CLI | **1.18.29** | `/global/health` on the running engine, read by `process-manager.ts` |

The binary version is read from the engine that is actually serving, which is
not necessarily the one we would have spawned — serve adopts an already-running
engine when it finds one. Managed startup resolves the binary from the pinned
`opencode-ai` dependency rather than searching PATH.
`opencode serve` answers 200 with an HTML shell for *any* unknown path, so
`/global/health` is the only endpoint that distinguishes a live engine from a
squatter; it returns `{"healthy":true,"version":"..."}`.

## Current dev runtime — 2026-10-12

The local engine reported version **1.19.0** while the SDK remained pinned to
1.18.29, causing the intentional boot lockstep check to stop Serve. The SDK and
the locally managed CLI package are now both pinned to exact version **1.19.0**.
Future engine or SDK updates must change both sides together and repeat the
adapter compatibility checks.

### What changed between 1.3.15 and 1.18.29

Diffed against the published types before upgrading (read-only, in `/tmp`):

- All eight wire literals the normalizer matches still exist unchanged:
  `message.part.updated`, `message.part.delta`, `session.status`, `session.idle`,
  `permission.asked`, `question.asked`, `session.error`, `message.updated`.
- The payloads the adapter reads are structurally identical. 1.18 adds a required
  `id` to every event and a `durable` block to some entities.
- `SessionStatus` is unchanged.
- New additive variants, all still handled by the `default:` arm or newly
  covered: `permission.v2.asked` / `question.v2.asked` (and their replied/rejected
  counterparts), a large `session.next.*` streaming family, and
  `worktree.ready` / `worktree.failed`.
- `Model` was the one genuine breaking change: `attachment`, `reasoning`,
  `temperature` and `tool_call` moved into a nested `capabilities` object, and
  `tool_call` became `capabilities.toolcall`. All four stay booleans, so the
  Chorus-owned `OpencodeModelSummary` is unchanged and the model picker needed no
  edit — the change is absorbed at the adapter boundary, which is the only place
  allowed to know it.

## Known drift

No SDK ↔ binary mismatch is outstanding in the current dev runtime: both report
**1.19.0**. The Phase 6 table above records the earlier **1.18.29** pairing; the
2026-10-12 entry is the current pairing. The adapter remains the only place
allowed to touch SDK types, so a future bump is contained to
`packages/opencode-adapter` and must update this ledger with the observed engine
version.

Resolution: the SDK pin and `opencode-ai` CLI package are both exact 1.19.0
dependencies. The boot assertion still detects a mismatch when an adopted
external engine differs from the SDK. Managed startup launches the local package
binary, not a globally installed executable.

## Update log

| Date | Phase | Change |
|---|---|---|
| 2026-10-01 | P0 | Baseline recorded; `packageManager` aligned to runtime 1.4.0 |
| 2026-10-12 | P6 | SDK exact pin advanced from 1.18.29 to 1.19.0 to restore lockstep with the running engine |
| 2026-10-12 | P6 | Added the exact `opencode-ai` 1.19.0 CLI dependency; managed engine startup now uses that binary |
