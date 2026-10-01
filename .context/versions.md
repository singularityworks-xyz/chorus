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

## Known drift

**SDK ↔ binary mismatch is live.** `@opencode-ai/sdk` resolves to 1.3.15 while the
spawned `opencode` binary is 1.18.29 — roughly 15 minor versions apart.

Impact: `packages/opencode-adapter` re-exports SDK `Event` / `SessionStatus`
types (`src/features/events/event-stream.ts:3`), so any event-shape drift in the
newer engine surfaces as type mismatches or silently mis-normalized events in the
projector. This is why the adapter is the only place allowed to touch the SDK.

Resolution: Phase 6, task 5. Bump `@opencode-ai/sdk` via `bun add`, pin the
spawned binary to the same version, diff the changelog, update the normalization
layer, and record the new pair here.

## Update log

| Date | Phase | Change |
|---|---|---|
| 2026-10-01 | P0 | Baseline recorded; `packageManager` aligned to runtime 1.4.0 |
