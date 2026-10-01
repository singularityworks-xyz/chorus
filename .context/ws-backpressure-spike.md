# WS Backpressure Spike — Findings

> Phase 3 Day-1 spike. Executed before writing any hub code, as the plan requires.
> Harness: `apps/serve/scripts/ws-backpressure-spike.ts`
> Reproduce: `bun run apps/serve/scripts/ws-backpressure-spike.ts`
> Date: 2026-10-01 · Bun 1.4.0 · Elysia `.ws()` over `Bun.serve` websockets

## Setup

A `Bun.serve` websocket that immediately pushes **4 000 × 8 KB** frames
(≈32 MB attempted) at a client that connects and then deliberately stops reading,
followed by a phase where the reader resumes.

## Results

| Question | Answer |
|---|---|
| `ws.send()` return type when buffer is full | **`number`** — bytes accepted (`8195` = 8192 payload + 3 frame bytes). Never `0`, never `-1`, across all 4 000 sends including a 16.7 MB backlog |
| Does `send()` signal backpressure? | **No.** Every call returned a positive count regardless of congestion |
| Peak `getBufferedAmount()` with a stalled reader | **16 782 710 bytes (16.0 MiB)** — no implicit cap anywhere in the stack |
| `drain` hook reliability | Fired **12 times**, so it does fire — but see below |
| Buffer at the *first* `drain` | **15 277 430 bytes** — already 91 % of the eventual peak |
| Does the buffer recover when the reader resumes? | **Yes** — dropped to `0` and stayed there; `recoveredToZero: true` |
| Messages lost | **0.** Client eventually received all of them; delivery was delayed, not dropped |

## Conclusions that drive the design

**1. `send()`'s return value is useless as a congestion signal.**
It reports what was accepted into *Bun's* buffer, not whether the peer is
keeping up. A hub that branched on it would believe it was always succeeding.

→ The hub must sample `getBufferedAmount()` itself, per send, and that sample is
the *only* usable pressure signal.

**2. There is no implicit high-water mark.**
16 MiB accumulated with no complaint. Unbounded growth is the default failure
mode, so a cap has to be imposed by us.

**3. `drain` is a late notification, not an early warning.**
It fired 12 times, but the first fire came with 15.2 MiB already queued. Treating
`drain` as the congestion signal would mean every client buffers ~15 MiB before
we ever noticed — which is precisely the unbounded-memory scenario spec §4 says
to avoid.

→ `drain` is used only to re-check `getBufferedAmount()` and consider clearing
the critical-only flag. It never *sets* one.

**4. The recovery path terminates, so critical-only is safe.**
Once the reader resumed, the buffer fell to `0` and stayed there. A client
flagged critical-only does clear, and the flag cannot latch forever.

**5. Nothing is dropped silently — but we still drop deliberately.**
Bun queued all 4 000 frames and delivered them late. That is fine for a stalled
socket that recovers, and unacceptable for one that never does. So the hub drops
*non-critical* patches above the mark and lets the client catch up via
`hello(since)` on reconnect (spec §4).

## Chosen parameters

| Parameter | Value | Rationale |
|---|---|---|
| `HIGH_WATER_MARK` | **262 144 bytes (256 KiB)** | ~30× a typical `step.delta_appended` patch; **60× below** the 15.2 MiB at which `drain` first surfaced. Reachable in ~32 messages of 8 KB, so it trips long before memory matters |
| `CRITICAL_ONLY` behaviour | control events only | Approvals and lane transitions must never be dropped; deltas are recoverable via resume |
| Recovery | clear the flag when `getBufferedAmount() < HIGH_WATER_MARK`, re-checked on `drain` and on a 1 s interval | `drain` alone is too late (finding 3) |
| Sample cost | one `getBufferedAmount()` per send per client | Measured in the spike loop at negligible cost for ≤10 clients (spec §8) |

## Rejected alternatives

- **Branch on `send()`'s return value** — finding 1 rules it out.
- **Use `drain` to detect congestion** — finding 3: 15 MiB too late.
- **HWM at 1 MiB** — defensible, but 4× more headroom than the payload mix needs
  before tripping, for no measured benefit.
- **Wait for Phase 9's load harness to pick the number** — the plan requires the
  HWM to be chosen at spike time; the load harness then validates it under real
  load rather than inventing it.