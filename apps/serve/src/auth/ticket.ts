/**
 * Single-use WebSocket upgrade tickets (spec §6.2, plan P4.3).
 *
 * The browser attaches an HttpOnly session cookie to a same-origin WS upgrade
 * on its own, so the happy path needs nothing here. The ticket exists for the
 * other case the spec calls out: a proxy that strips cookies on the upgrade.
 * Such a client fetches a ticket over an authenticated HTTP request and
 * presents it once.
 *
 * Single-use is the whole point. A ticket that could be replayed would be a
 * bearer credential with a 5-minute lifetime and no other bound, which is a
 * weaker property than the 30-day cookie it exists to stand in for. Consuming
 * therefore *deletes before it decides*, so two concurrent upgrades carrying
 * the same ticket cannot both win.
 */

/** 16 bytes → 32 hex chars. */
const TICKET_BYTES = 16;

/** Plan P4.3: five minutes. */
export const TICKET_TTL_MS = 300_000;

const TICKET_KEY_PREFIX = "wst:";

/** 16 bytes hex-encoded: 32 lowercase hex chars. */
const TICKET_SHAPE = /^[0-9a-f]{32}$/;

/**
 * The slice of database surface a ticket store needs.
 *
 * Declared as an interface so this module has no dependency on the store or on
 * SQLite, and so a test can drive expiry with a fake clock.
 */
export interface TicketStore {
  deleteMeta(key: string): void;
  /** Every `key`/`value` pair whose key starts with `prefix`. */
  entriesWithPrefix(prefix: string): [string, string][];
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export interface TicketOptions {
  now?: () => number;
  store: TicketStore;
  ttlMs?: number;
}

export function generateTicket(): string {
  const bytes = new Uint8Array(TICKET_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ticketMetaKey(ticket: string): string {
  return `${TICKET_KEY_PREFIX}${ticket}`;
}

/**
 * Issues a ticket and stores its expiry timestamp.
 *
 * The stored value is the absolute expiry in ms, so consumption needs no
 * knowledge of when it was issued and cannot drift if the TTL constant changes.
 */
export function issueTicket(options: TicketOptions): string {
  const now = options.now ?? Date.now;
  const ticket = generateTicket();

  options.store.setMeta(
    ticketMetaKey(ticket),
    String(now() + (options.ttlMs ?? TICKET_TTL_MS))
  );

  return ticket;
}

export type ConsumeResult = "consumed" | "expired" | "unknown";

/**
 * Consumes a ticket exactly once.
 *
 * The row is deleted before the result is returned, including for an expired or
 * unknown ticket, so a replay is observably `unknown` rather than re-deciding
 * the same answer forever. A client that presents an expired ticket is told to
 * fetch a new one rather than being allowed to retry against a stale row.
 */
export function consumeTicket(
  ticket: string | undefined | null,
  options: TicketOptions
): ConsumeResult {
  if (!(ticket && TICKET_SHAPE.test(ticket))) {
    return "unknown";
  }

  const key = ticketMetaKey(ticket);
  const raw = options.store.getMeta(key);
  options.store.deleteMeta(key);

  if (raw === null) {
    return "unknown";
  }

  const expiresAt = Number.parseInt(raw, 10);
  if (!Number.isFinite(expiresAt)) {
    return "unknown";
  }

  const now = options.now ?? Date.now;
  return now() < expiresAt ? "consumed" : "expired";
}

/**
 * Drops tickets past their expiry.
 *
 * Without this a client that fetched a ticket and never upgraded leaves a row
 * behind forever; `pruneMutationIds` only sweeps the `mut:` prefix, so the
 * `meta` table has no other janitor for `wst:`.
 */
export function pruneExpiredTickets(
  store: TicketStore,
  now: number = Date.now()
): number {
  let pruned = 0;

  for (const [key, value] of store.entriesWithPrefix(TICKET_KEY_PREFIX)) {
    const expiresAt = Number.parseInt(value, 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      store.deleteMeta(key);
      pruned += 1;
    }
  }

  return pruned;
}
