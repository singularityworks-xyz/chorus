# Phase 6/7 Follow-up Verification

Date: 2026-10-12

Branch: `codex/workspace-device-completion`

This records verification after correcting the Phase 6 startup-reconciliation
race and the Windows child-process window behavior. Browser E2E was not run, per
the operator's instruction.

## Changes covered

- Startup reconciliation now publishes status, permission, and question state
  only for sessions already attached to recoverable board work. The recovery
  provider excludes boards without a current task.
- The eight-run qualification now compares JSON wire representations so omitted
  `undefined` fields and object-key order do not create false WebSocket mirror
  failures. Timeout diagnostics include board/session state, and cleanup errors
  no longer mask the original harness failure.
- Noninteractive Git fixtures, process-backed test children, managed OpenCode
  startup, the snapshot Git helper, and the native folder-picker subprocess set
  `windowsHide: true` on Windows. The E2E fixture setup has the same setting;
  E2E itself was not executed.

## Commands and results

| Command | Result |
|---|---|
| `bun test apps/serve/src/bridge/opencode/bridge.test.ts apps/serve/scripts/phase-6-harness.test.ts` | Passed: 9 tests across 2 files. The qualification exercised 8 isolated runs, 3 real Git repositories, 10 authenticated WebSocket mirrors, approval/reply, snapshot diff, and board-scoped session diff. |
| `bun test apps/serve/src/auth/auth-matrix.test.ts apps/serve/src/workspace/store-restart.test.ts apps/serve/src/projects/repository-registry.test.ts apps/serve/src/projects/worktree-manager.test.ts apps/serve/src/projects/worktree-concurrency.test.ts apps/serve/src/snapshot/index.test.ts` | Passed: 77 tests across 6 files. |
| `bun run check` | Passed; formatting/lint and log gate are green. |
| `bun run check-types` | Passed: root TypeScript check and all 7 workspace package checks. Turbo required the reviewed elevated runner because the sandbox denied access to workspace state. |
| `bun run build` | Passed: Next.js 16.2.2 production build compiled, type-checked, generated all 24 static pages, and included `/api/sessions/[sessionID]/diff`. |

The first post-fix qualification attempt exposed a harness comparison mismatch;
the final run passed after comparing the same JSON representation that clients
receive. The bridge regression test also confirms unrelated idle sessions and
their pending requests are ignored during recovery.

## Follow-up verification — 2026-10-12

The first ten-minute load measurement missed the RSS budget at 54.11 MB. Review
found that `WorkspaceStore` counted events toward the configured snapshot
interval, but no normal commit path applied it. The store now writes a snapshot
when that interval is reached, logs snapshot failures without misreporting an
already durable mutation, and only swaps the retained in-memory snapshot after
its database write succeeds. A regression test verifies event pruning and state
recovery across restart. The load also exposed and verified a WebSocket heartbeat
deadline correction; the harness now responds with the protocol's exact `pong`
shape and resynchronizes clients after sequence gaps.

| Command | Result |
|---|---|
| `bun test apps/serve/src/workspace/store.test.ts apps/serve/src/ws/hub.test.ts apps/serve/scripts/phase-6-harness.test.ts` | Passed: 84 tests across 3 files, including the eight-run qualification, automatic snapshot/restart and snapshot-failure regressions, and heartbeat regression. |
| `bun run check` | Passed; formatting and log gate are green. |
| `bun run check-types` | Passed across all 7 workspace packages. |
| `bun run apps/serve/scripts/phase-6-load.ts` | Passed: 600 seconds, 120,000 events at 200/s, p95 latency 113 ms, peak RSS growth 42.68 MB, final snapshot 133,813 bytes, eight checkouts, and ten converged mirrors. Full measurements are in [phase-6-load-report.md](./phase-6-load-report.md). |

The sandbox denied Git writes in the temporary fixture directories on the first
load and focused-harness attempts. Both commands passed outside the sandbox; the
fixtures used hidden Git child windows, and no Windows Terminal/OpenConsole
processes appeared during the load runs. No browser E2E was run.

## Still open

- Credentialed real-model inference and target-deployment engine-pool capacity.
- Active-session server-restart acceptance.
- Manual desktop folder-picker acceptance.
- Live-engine abort/removal qualification beyond the focused lifecycle tests.
- Real Chrome and installed iOS Safari push delivery, including offline-device
notification click and login recovery.
- Browser E2E. It remains unrun at the operator's request.

These results improve deterministic implementation evidence; they do not close
the Phase 6/7 release gates above.
