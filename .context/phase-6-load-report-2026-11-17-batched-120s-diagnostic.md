# Phase 6 scripted load report

Date: 2026-11-17T03:51:03.217Z

Runtime: Bun 1.4.4; darwin/arm64.

Eight scripted engine runs, three real Git repositories, ten authenticated WebSocket clients. No provider inference or browser automation. Commands use real HTTP, engine events traverse SDK/SSE/normalization, and workspaces persist through SQLite.

| Measurement | Result | Budget |
|---|---:|---:|
| Duration | 120.01 s | ≥600 s sustained; ≥1,800 s for 30-minute soak |
| Raw streamed events | 24000 | 200/s |
| Persisted domain events during stream and completion | 9608 | informational; deltas are losslessly batched |
| Achieved rate | 199.99/s | ≥199/s (timer tolerance) |
| WS frames | 97360 | coalesced sequence ranges |
| p95 normalized-event-to-client latency | 165 ms | ≤200 ms |
| Peak RSS growth after warmup | 6.50 MB | ≤50 MB |
| Final snapshot | 41531 bytes | <1 MB |
| Distinct checkouts | 8 | 8 |

All ten mirrors match the final server boards. Latency uses a bounded ring of the latest 20,000 received frames, including coalesced frame ranges; the rate counts raw engine deltas, not frames. The persisted-event count begins after a warmup batch and includes terminal completion events. The harness and fixture share the Bun process with Serve modules, so RSS includes their allocations.

Result: **PASS** (short diagnostic; does not satisfy the ten-minute gate).
