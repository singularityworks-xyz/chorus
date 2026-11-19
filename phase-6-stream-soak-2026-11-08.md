# Phase 6 scripted load report

Date: 2026-11-08T18:02:56.116Z

Runtime: Bun 1.4.4; darwin/arm64.

Eight scripted engine runs, three real Git repositories, ten authenticated WebSocket clients. No provider inference or browser automation. Commands use real HTTP, engine events traverse SDK/SSE/normalization, and workspaces persist through SQLite.

| Measurement | Result | Budget |
|---|---:|---:|
| Duration | 600.00 s | 600 s for release qualification |
| Raw streamed events | 120000 | 200/s |
| Achieved rate | 200.00/s | ≥199/s (timer tolerance) |
| WS frames | 646060 | coalesced sequence ranges |
| p95 normalized-event-to-client latency | 114 ms | ≤200 ms |
| Peak RSS growth after warmup | 21.27 MB | ≤50 MB |
| Final snapshot | 135661 bytes | <1 MB |
| Distinct checkouts | 8 | 8 |

All ten mirrors match the final server boards. Latency uses a bounded ring of the latest 20,000 received frames, including coalesced frame ranges; the rate counts raw engine deltas, not frames. The harness and fixture share the Bun process with Serve modules, so RSS includes their allocations.

Result: **PASS**.
