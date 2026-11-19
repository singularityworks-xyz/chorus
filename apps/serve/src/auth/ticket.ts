import { z } from "zod";

const TICKET_BYTES = 16;

export const TICKET_TTL_MS = 300_000;

const TICKET_KEY_PREFIX = "wst:";

const TICKET_SHAPE = /^[0-9a-f]{32}$/;
const LEGACY_TICKET_EXPIRY = /^\d+$/;

export interface TicketStore {
  deleteMeta(key: string): void;

  entriesWithPrefix(prefix: string): [string, string][];
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export interface TicketOptions {
  deviceId?: string;
  now?: () => number;
  store: TicketStore;
  ttlMs?: number;
}

const ticketValueSchema = z.union([
  z.number().finite(),
  z.object({
    deviceId: z.string().regex(/^[0-9a-f]{32}$/),
    expiresAt: z.number().finite(),
  }),
]);

type TicketValue = z.infer<typeof ticketValueSchema>;

function parseTicketValue(raw: string): TicketValue | null {
  if (LEGACY_TICKET_EXPIRY.test(raw)) {
    const expiresAt = Number(raw);
    return Number.isFinite(expiresAt) ? expiresAt : null;
  }
  try {
    const parsed = ticketValueSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function generateTicket(): string {
  const bytes = new Uint8Array(TICKET_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ticketMetaKey(ticket: string): string {
  return `${TICKET_KEY_PREFIX}${ticket}`;
}

export function issueTicket(options: TicketOptions): string {
  const now = options.now ?? Date.now;
  const ticket = generateTicket();
  const expiresAt = now() + (options.ttlMs ?? TICKET_TTL_MS);

  options.store.setMeta(
    ticketMetaKey(ticket),
    options.deviceId
      ? JSON.stringify({ deviceId: options.deviceId, expiresAt })
      : String(expiresAt)
  );

  return ticket;
}

export type ConsumeResult = "consumed" | "expired" | "unknown";

export interface TicketConsumeOutcome {
  deviceId?: string;
  result: ConsumeResult;
}

export function consumeTicket(
  ticket: string | undefined | null,
  options: TicketOptions
): ConsumeResult {
  return consumeTicketIdentity(ticket, options).result;
}

export function consumeTicketIdentity(
  ticket: string | undefined | null,
  options: TicketOptions
): TicketConsumeOutcome {
  if (!(ticket && TICKET_SHAPE.test(ticket))) {
    return { result: "unknown" };
  }

  const key = ticketMetaKey(ticket);
  const raw = options.store.getMeta(key);
  options.store.deleteMeta(key);

  if (raw === null) {
    return { result: "unknown" };
  }

  const value = parseTicketValue(raw);
  const expiresAt = ticketExpiry(value);
  if (!Number.isFinite(expiresAt)) {
    return { result: "unknown" };
  }

  if (
    options.deviceId &&
    (value === null ||
      typeof value === "number" ||
      value.deviceId !== options.deviceId)
  ) {
    return { result: "unknown" };
  }

  const now = options.now ?? Date.now;
  if (now() >= expiresAt) {
    return { result: "expired" };
  }
  return {
    ...(value !== null && typeof value === "object"
      ? { deviceId: value.deviceId }
      : {}),
    result: "consumed",
  };
}

export function pruneExpiredTickets(
  store: TicketStore,
  now: number = Date.now()
): number {
  let pruned = 0;

  for (const [key, value] of store.entriesWithPrefix(TICKET_KEY_PREFIX)) {
    const parsed = parseTicketValue(value);
    const expiresAt = ticketExpiry(parsed);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      store.deleteMeta(key);
      pruned += 1;
    }
  }

  return pruned;
}

function ticketExpiry(value: TicketValue | null): number {
  if (value === null) {
    return Number.NaN;
  }
  return typeof value === "number" ? value : value.expiresAt;
}
