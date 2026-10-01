# WS Backpressure Spike — Findings

> Phase 3 Day-1 spike, executed before hub code, as the plan requires.
> Harness: `apps/serve/src/ws/spike.ts` — run with
> `bun run apps/serve/src/ws/spike.ts`
> Date: 2026-10-01 · Bun 1.4.0 · Elysia 1.4.30 · `.ws()` over `Bun.serve`

## ⚠️ Measurement correction

The first version of this spike drove `Bun.serve` directly and concluded that
`ws.send()`'s return value was **useless** as a congestion signal — 4000/4000
sends returned a positive byte count against a 16 MiB backlog. That conclusion
was wrong, because it measured the wrong layer.

Elysia wraps the socket, and its context documents a different contract:

```
 * - if **0**, the message was **dropped**.
 * - if **-1**, there is **backpressure** of messages.
 * - if **>0**, it represents the **number of bytes sent**.
```

Re-measured through Elysia — the layer the hub actually runs on — `send()` reports
congestion exactly as documented. The spike harness was rewritten to drive
Elysia, and `HIGH_WATER_MARK` below is derived from these numbers.

## Setup

An Elysia `.ws()` route pushes **3 000 × 8 KB** frames (≈24 MB attempted) at a
client that connects and then stops draining.

## Results (Elysia layer)

| Question | Answer |
|---|---|
| `send()` under a stalled reader | **`-1` × 2242**, **`0` × 435**, `>0` × 323 |
| Peak `ctx.raw.getBufferedAmount()` | **16 782 710 bytes (16.0 MiB)** — still no implicit cap |
| `ctx.raw.getBufferedAmount` exposed? | **Yes** — even though the context itself does **not** have the member |
| `ctx.getBufferedAmount` on the context? | **No.** Only via `ctx.raw` |
| Is `ctx.id` a usable registry key? | **Yes — a stable string** (`"83cfb603fd182a12"`) |
| Are `open` / `message` / `close` given the same object? | **No.** Elysia hands each handler a *different wrapper* for the same connection |

## Conclusions that drive the design

**1. `send()`'s return value is the primary congestion signal — and it is cheaper
than polling.** Elysia reports `-1` for backpressure and `0` for dropped. That
means the hub can learn a socket is congested from the send it just attempted,
with no extra syscall. The earlier "poll `getBufferedAmount`" design was solving
a problem that does not exist on this layer.

**2. Byte volume is still worth measuring, via `ctx.raw`.** `getBufferedAmount`
is not on the context, but `ctx.raw` exposes it. Keeping both gives a cheap
immediate trigger (`send() < 0`) and a stronger magnitude signal (buffered bytes),
which is what `HIGH_WATER_MARK` is sized against.

**3. There is still no implicit cap.** 16 MiB accumulated silently, so a cap has
to be imposed regardless of which signal trips first.

**4. Clients must be keyed by `ctx.id`, never by socket object identity.**
This was a real bug, not a hypothetical: the hub originally stored sockets in a
`Set` and looked them up with `client.socket === socket`. Because Elysia passes a
*different wrapper object* to `open` than to `message`, that lookup missed every
time — the handshake silently produced zero frames and no error was logged.
`ctx.id` is a stable per-connection string and is what the registry uses.

**5. `0` means dropped, which is not the same as backpressured.** `-1` means "try
later"; `0` means Bun discarded the frame. Both indicate a sick socket, and both
justify the same critical-only response, but a `0` is stronger evidence that the
peer is gone — it is counted separately for diagnostics.

## Chosen parameters

| Parameter | Value | Rationale |
|---|---|---|
| Congestion trigger | `send()` returning `< 0`, **or** `raw.getBufferedAmount() > HIGH_WATER_MARK` | Immediate and cheap; the byte check is the magnitude guard |
| `HIGH_WATER_MARK` | **262 144 bytes (256 KiB)** | ~30× a typical step-delta patch; **64× below** the 16 MiB observed. Trips long before memory matters |
| Recovery | clear critical-only after sustained positive sends **and** buffer `< ½ HWM` | A single positive send after a stall is not proof the socket recovered |
| Registry key | `ctx.id` | Stable across handlers; object identity is not (finding 4) |

## Rejected alternatives

- **Key the registry by socket object** — finding 4; this is the bug that shipped
  in the first cut of the hub and was only caught by the live socket check.
- **Rely on `send() > 0` alone** — 323 positive returns happened against a 16 MiB
  backlog, so a positive send proves nothing on its own.
- **Poll `getBufferedAmount` alone** — not available on the Elysia context
  (only via `raw`), and strictly more expensive than reading `send()`'s result.
- **Use the `drain` hook to detect congestion** — in the Bun-layer run it first
  fired with 15 MiB already queued. Under Elysia the same `drain` hook exists and
  remains a *late notification*, useful only as a nudge to re-check.