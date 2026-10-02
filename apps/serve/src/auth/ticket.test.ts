import { describe, expect, test } from "bun:test";
import {
  consumeTicket,
  generateTicket,
  issueTicket,
  pruneExpiredTickets,
  TICKET_TTL_MS,
  type TicketStore,
  ticketMetaKey,
} from "./ticket";

/**
 * In-memory stand-in for the store's `meta` table.
 *
 * The plan allows a real database, but the point of these tests is the ticket
 * state machine — consume-before-decide, TTL, pruning — and a map exercises it
 * without SQLite transaction timing in the way.
 */
const HEX_32 = /^[0-9a-f]{32}$/;

function makeStore(): TicketStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();

  return {
    deleteMeta: (key) => {
      rows.delete(key);
    },
    entriesWithPrefix: (prefix) =>
      [...rows].filter(([key]) => key.startsWith(prefix)),
    getMeta: (key) => rows.get(key) ?? null,
    rows,
    setMeta: (key, value) => {
      rows.set(key, value);
    },
  };
}

describe("WebSocket upgrade tickets (spec §6.2, plan P4.3)", () => {
  test("tickets are 32 hex chars and unique", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      seen.add(generateTicket());
    }

    expect([...seen].every((ticket) => HEX_32.test(ticket))).toBe(true);
    expect(seen.size).toBe(64);
  });

  test("an issued ticket is consumable exactly once", () => {
    const clock = 1_700_000_000_000;
    const store = makeStore();
    const options = { now: () => clock, store };
    const ticket = issueTicket(options);

    expect(consumeTicket(ticket, options)).toBe("consumed");

    // Single-use is the whole point: a replayable ticket is a bearer credential
    // with no bound other than its TTL.
    expect(consumeTicket(ticket, options)).toBe("unknown");
  });

  test("a consumed ticket leaves no row behind", () => {
    const store = makeStore();
    const options = { now: () => Date.now(), store };
    const ticket = issueTicket(options);

    expect(store.rows.size).toBe(1);
    consumeTicket(ticket, options);
    expect(store.rows.size).toBe(0);
  });

  test("an expired ticket is refused and deleted", () => {
    let clock = 1_700_000_000_000;
    const store = makeStore();
    const options = { now: () => clock, store };
    const ticket = issueTicket(options);

    clock += TICKET_TTL_MS;

    expect(consumeTicket(ticket, options)).toBe("expired");
    // Deleted even though it was refused, so it cannot be re-decided forever.
    expect(store.rows.size).toBe(0);
  });

  test("one millisecond before expiry still works", () => {
    let clock = 1_700_000_000_000;
    const store = makeStore();
    const options = { now: () => clock, store };
    const ticket = issueTicket(options);

    clock += TICKET_TTL_MS - 1;

    expect(consumeTicket(ticket, options)).toBe("consumed");
  });

  test("the TTL is five minutes", () => {
    expect(TICKET_TTL_MS).toBe(300_000);
  });

  test("unknown and malformed tickets are refused without touching the store", () => {
    const store = makeStore();
    const options = { now: () => Date.now(), store };
    store.setMeta(ticketMetaKey("a".repeat(32)), String(Date.now() + 1000));

    expect(consumeTicket("b".repeat(32), options)).toBe("unknown");
    expect(consumeTicket(undefined, options)).toBe("unknown");
    expect(consumeTicket(null, options)).toBe("unknown");
    expect(consumeTicket("", options)).toBe("unknown");
    expect(consumeTicket("../../etc/passwd", options)).toBe("unknown");
    expect(consumeTicket("NOTHEX", options)).toBe("unknown");

    // The unrelated valid row survived all of that.
    expect(store.rows.size).toBe(1);
  });

  test("a row with a non-numeric expiry is refused", () => {
    const store = makeStore();
    const options = { now: () => Date.now(), store };
    store.setMeta(ticketMetaKey("c".repeat(32)), "not-a-number");

    expect(consumeTicket("c".repeat(32), options)).toBe("unknown");
  });

  test("pruning removes expired tickets and leaves live ones", () => {
    let clock = 1_700_000_000_000;
    const store = makeStore();
    const options = { now: () => clock, store };

    issueTicket(options);
    // Age the first ticket out, then issue a second with a long TTL so exactly
    // one row is due for pruning.
    clock += TICKET_TTL_MS + 1;
    const live = issueTicket({ ...options, ttlMs: TICKET_TTL_MS * 10 });
    clock += TICKET_TTL_MS;

    const pruned = pruneExpiredTickets(store, clock);

    expect(pruned).toBe(1);
    expect([...store.rows.keys()]).toEqual([ticketMetaKey(live)]);
  });

  test("pruning never touches rows outside the ticket prefix", () => {
    const store = makeStore();
    store.setMeta("mut:some-id", "1");
    store.setMeta("head_seq", "42");

    const pruned = pruneExpiredTickets(store, 2_000_000_000_000);

    expect(pruned).toBe(0);
    expect(store.rows.size).toBe(2);
  });

  test("a ticket issued under one clock is judged by the consumer clock", () => {
    const store = makeStore();
    const issued = issueTicket({ now: () => 1000, store });

    // Storing an absolute expiry means consumption does not depend on when the
    // ticket was issued or on the TTL constant having stayed the same.
    expect(
      consumeTicket(issued, { now: () => 1000 + TICKET_TTL_MS - 1, store })
    ).toBe("consumed");
  });
});
