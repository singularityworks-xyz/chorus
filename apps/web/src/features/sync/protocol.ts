import { serverMessageSchema } from "@chorus/contracts";

/**
 * Client-side handling of the sequenced stream (spec §4, plan P5 task 1).
 *
 * The hub coalesces a burst of log rows into one frame and declares the range it
 * covers (`fromSeq`..`seq`). The client therefore has two cursors' worth of
 * information: what it has applied (`lastSeq`) and what the frame starts at
 * (`fromSeq`). Getting this wrong is how a client ends up silently diverging
 * from the server, so the decision is a pure function with its own tests rather
 * than inline comparisons in a message handler.
 */

export type ServerFrame = ReturnType<typeof serverMessageSchema.parse>;

/**
 * What to do with an inbound `event` frame.
 *
 * - `apply` — contiguous with what the client has, or the first frame after a
 *   fresh handshake.
 * - `duplicate` — already covered by the cursor. The hub skips these, but a
 *   replay that overlapped a snapshot would otherwise re-apply a transcript.
 * - `gap` — the frame starts past the cursor. The client cannot know what it
 *   missed, so it asks for a snapshot rather than guessing.
 */
export type FrameDecision =
  | { action: "apply"; nextSeq: number }
  | { action: "duplicate"; nextSeq: number }
  | { action: "gap"; expected: number; got: number };

/**
 * Decides what an `event` frame means.
 *
 * `lastSeq` is the highest sequence the client has *contiguously* applied;
 * `0` means it has no history.
 */
export function decideFrame(
  frame: { fromSeq: number; seq: number },
  lastSeq: number
): FrameDecision {
  const nextSeq = Math.max(lastSeq, frame.seq);

  if (frame.seq <= lastSeq) {
    return { action: "duplicate", nextSeq };
  }

  // `fromSeq === lastSeq + 1` is the only contiguous case. A frame that starts
  // *before* the cursor but ends after it is also not safely applicable: the
  // client would re-apply the overlapping prefix. That cannot happen against the
  // hub, which ranges never overlap, but treating it as a gap is the safe
  // reading and costs one snapshot rather than a corrupted transcript.
  if (frame.fromSeq !== lastSeq + 1) {
    return { action: "gap", expected: lastSeq + 1, got: frame.fromSeq };
  }

  return { action: "apply", nextSeq };
}

/**
 * Parses a raw socket payload into a validated server frame.
 *
 * Returns `null` rather than throwing: a malformed frame from a version-mismatched
 * server must not tear down a live socket, and the schema is the boundary that
 * keeps third-party shapes out of app state.
 */
export function parseServerFrame(raw: string): ServerFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = serverMessageSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Drops the buffered events a snapshot already contains.
 *
 * A snapshot is taken at the server's current head, so it already reflects every
 * event the client buffered. Replaying them on top of it folds each one through
 * the shared projector a second time, and the projector is not idempotent:
 * `card.created` appends (duplicate cards) and `step.delta_appended`
 * concatenates (duplicated streamed text).
 *
 * Sequences at or below the snapshot's are therefore not "replay", they are
 * duplication. Anything above it arrived after the snapshot was cut and still
 * has to be applied.
 */
export function eventsAfterSnapshot<T extends { seq: number }>(
  buffered: readonly T[],
  snapshotSeq: number
): T[] {
  return buffered.filter((entry) => entry.seq > snapshotSeq);
}
