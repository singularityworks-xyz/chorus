# Phase 6 reasoning burst report

Date: 2026-11-16

Runtime: Bun 1.4.4; darwin/arm64.

The isolated `phase-6-harness.ts` sent reasoning deltas through the scripted OpenCode SDK/SSE path, Chorus normalization, SQLite persistence, and ten authenticated WebSocket mirrors for eight board tasks. No browser automation, external provider, or paid inference was used.

| Measurement | Result | Budget |
|---|---:|---:|
| Duration | 10.002 s | 10 s |
| Reasoning deltas | 5,000 | 500/s |
| Achieved rate | 499.90/s | ≥499/s timer tolerance |
| p95 normalized-event-to-client latency | 111 ms | ≤200 ms |
| Peak RSS growth after warmup | 15.86 MiB | ≤50 MiB |
| Final snapshot | 152,171 bytes | <1 MB |
| WebSocket frames | 11,490 | coalesced sequence ranges |
| Client mirrors | 10/10 converged | exact final-board match |

Result: **PASS**.

This measures server-to-client event delivery and state convergence. It does not measure browser rendering/input latency, a 1 MiB expanded transcript, or real-provider reasoning output.
