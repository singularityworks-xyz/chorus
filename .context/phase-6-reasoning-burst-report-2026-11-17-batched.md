# Phase 6 reasoning burst report

Date: 2026-11-17T04:22:57.936Z

Runtime: Bun 1.4.4; darwin/arm64.

Eight scripted engine tasks, three Git repositories, and ten authenticated WebSocket mirrors. Reasoning deltas traverse the real HTTP, SDK/SSE, normalization, SQLite, and WebSocket paths. No browser automation, external provider, or paid inference was used.

| Measurement | Result | Budget |
|---|---:|---:|
| Duration | 10.002 s | 10 s |
| Reasoning deltas | 5000 | 5,000 |
| Achieved rate | 499.90/s | ≥499/s (timer tolerance) |
| p95 normalized-event-to-client latency | 162 ms | ≤200 ms |
| Peak RSS growth after warmup | 6.25 MiB | ≤50 MiB |
| Final snapshot | 152170 bytes | <1 MB |
| WebSocket frames | 9360 | coalesced sequence ranges |
| Client mirrors | 10/10 converged | exact final-board match |

Result: **PASS**. Browser rendering/input latency and live-provider reasoning are outside this server-side qualification.
