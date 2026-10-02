/**
 * Persisted resume cursor and snapshot (plan P5 task 1).
 *
 * The plan asks for `localStorage["chorus:lastSeq"]` so a hard refresh receives
 * only the gap rather than a full snapshot. On its own that is incoherent: a
 * reload throws away in-memory state, so resuming from a cursor would leave the
 * client rendering an empty workspace forever. The cursor is only useful if the
 * state it refers to survives too, so both are persisted here and the snapshot is
 * bounded — spec §8 keeps a workspace under 1 MB, and `localStorage` is roughly
 * 5 MB, so there is room for one snapshot plus the cursor.
 *
 * Every read is defensive. `localStorage` throws outright in Safari private mode
 * and when a page is blocked from storage, a value can be truncated by another
 * tab mid-write, and a stale build can leave keys that no longer parse. Every one
 * of those cases degrades to "no history", which forces a snapshot — the safe
 * direction, because the alternative is a client that resumes from a nonsense
 * sequence and either replays history it already applied or sits permanently
 * ahead of the server.
 */

export const LAST_SEQ_KEY = "chorus:lastSeq";
export const SNAPSHOT_KEY = "chorus:snapshot";

/**
 * Refuse to store a snapshot larger than this.
 *
 * Quota-exceeded is handled too, but refusing up front keeps a pathological
 * workspace from evicting the cursor, which is the part that cannot be
 * regenerated without a round trip.
 */
export const MAX_PERSISTED_SNAPSHOT_BYTES = 2_000_000;

/**
 * The slice of `Storage` this module uses, so tests need no DOM and a hostile
 * environment can be simulated exactly.
 */
export interface SequenceStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

/**
 * Coerces a persisted value to a usable cursor.
 *
 * Returns `null` for anything that is not a non-negative safe integer, which the
 * callers treat as "no history" and force a snapshot for.
 */
export function parseLastSeq(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // `Number("")` is 0 and `Number(" ")` is 0, which is why the empty check is
  // above rather than relying on the parse.
  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed)) {
    return null;
  }
  // A negative or fractional cursor cannot come from the server's sequence
  // allocator, so it is corruption regardless of what it parses to.
  if (parsed < 0 || !Number.isInteger(parsed)) {
    return null;
  }
  if (parsed > Number.MAX_SAFE_INTEGER) {
    return null;
  }

  return parsed;
}

/**
 * Reads the cursor, degrading to `null` on any failure.
 *
 * A storage read that *throws* is treated exactly like a corrupt value: force a
 * snapshot rather than resume from a guess.
 */
export function readLastSeq(storage: SequenceStorage | null): number | null {
  if (!storage) {
    return null;
  }

  try {
    return parseLastSeq(storage.getItem(LAST_SEQ_KEY));
  } catch {
    return null;
  }
}

/** Reads the persisted snapshot, or `null` when absent, corrupt, or too large. */
export function readPersistedSnapshot(
  storage: SequenceStorage | null
): { seq: number; snapshot: unknown } | null {
  if (!storage) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(SNAPSHOT_KEY);
  } catch {
    return null;
  }

  if (raw === null || raw.length > MAX_PERSISTED_SNAPSHOT_BYTES) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { seq?: unknown; snapshot?: unknown };

    if (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) < 0) {
      return null;
    }
    if (typeof parsed.snapshot !== "object" || parsed.snapshot === null) {
      return null;
    }

    return { seq: parsed.seq as number, snapshot: parsed.snapshot };
  } catch {
    // Truncated by another tab mid-write, or written by an older build.
    return null;
  }
}

/**
 * Persists the snapshot alongside the cursor.
 *
 * Best effort. When it fails — quota, private mode — the cursor is cleared too,
 * because a cursor without its snapshot would make the next load resume from a
 * gap with nothing to show.
 */
/**
 * Persists the snapshot and the cursor together.
 *
 * The cursor is deliberately *not* advanced as live events are applied. A cursor
 * only means something alongside the state it refers to: writing "the client has
 * seen up to N" without persisting the matching state would leave a reload
 * resuming from a hole with nothing on screen. Pinning both to the snapshot keeps
 * the pair coherent, and the cost is only that a reload replays the events after
 * the last snapshot instead of skipping them.
 */
export function writePersistedSnapshot(
  storage: SequenceStorage | null,
  snapshot: unknown,
  seq: number
): void {
  if (!(storage && Number.isSafeInteger(seq)) || seq < 0) {
    return;
  }

  let serialised: string;
  try {
    serialised = JSON.stringify({ seq, snapshot });
  } catch {
    // Circular or otherwise unserialisable. Treat as "cannot persist".
    return;
  }

  if (serialised.length > MAX_PERSISTED_SNAPSHOT_BYTES) {
    return;
  }

  try {
    storage.setItem(SNAPSHOT_KEY, serialised);
    storage.setItem(LAST_SEQ_KEY, String(seq));
  } catch {
    // A cursor with no snapshot would strand the next load, so drop both.
    clearPersistedState(storage);
  }
}

/** Clears cursor and snapshot together. */
export function clearPersistedState(storage: SequenceStorage | null): void {
  clearLastSeq(storage);
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Same as above.
  }
}

export function clearLastSeq(storage: SequenceStorage | null): void {
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(LAST_SEQ_KEY);
  } catch {
    // Same as above.
  }
}

/**
 * Access to `localStorage` that cannot throw during module evaluation.
 *
 * Reading `window.localStorage` itself throws in some privacy configurations, so
 * even obtaining the reference is guarded.
 */
export function browserStorage(): SequenceStorage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
