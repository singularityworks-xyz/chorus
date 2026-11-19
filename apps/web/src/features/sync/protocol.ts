import { serverMessageSchema } from "@chorus/contracts";

export type ServerFrame = ReturnType<typeof serverMessageSchema.parse>;

export type FrameDecision =
  | { action: "apply"; nextSeq: number }
  | { action: "duplicate"; nextSeq: number }
  | { action: "gap"; expected: number; got: number };

export function decideFrame(
  frame: { fromSeq: number; seq: number },
  lastSeq: number
): FrameDecision {
  const nextSeq = Math.max(lastSeq, frame.seq);

  if (frame.seq <= lastSeq) {
    return { action: "duplicate", nextSeq };
  }
  // Only a contiguous range can advance applied state.
  if (frame.fromSeq !== lastSeq + 1) {
    return { action: "gap", expected: lastSeq + 1, got: frame.fromSeq };
  }

  return { action: "apply", nextSeq };
}

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

export function eventsAfterSnapshot<T extends { seq: number }>(
  buffered: readonly T[],
  snapshotSeq: number
): T[] {
  return buffered.filter((entry) => entry.seq > snapshotSeq);
}
