import { status } from "elysia";
import { deviceIdFromHeader } from "./device";
import { readSessionCookie, verifySessionCookie } from "./session";
import { consumeTicketIdentity, type TicketOptions } from "./ticket";

/**
 * Request authentication (spec §6.1/§6.2, plan P4.2/P4.3).
 *
 * ## Why `onBeforeHandle` and not `resolve`
 *
 * Elysia's `resolve` does `Object.assign(context, resolved)` on a plain object
 * return and *silently ignores a raw `Response`* — a `Response` has no own
 * enumerable properties, so the assignment is a no-op and **the handler still
 * runs**. A guard written that way looks correct and protects nothing. Only
 * `onBeforeHandle` short-circuits on an arbitrary return value.
 *
 * ## Why the exemption list lives here
 *
 * `resolve`/`onBeforeHandle` are snapshotted when a route is registered, so a
 * scoped guard applies to routes registered *after* it. There is no `except`
 * option in 1.4 and no order-independent alternative except `onRequest` (which
 * has no cookie access). So the public paths are allowed inside the hook, and
 * `auth-matrix.test.ts` asserts real 401s to prove the guard is actually
 * attached rather than merely present.
 *
 * ## Why `/ws` is passed through
 *
 * A browser cannot read a 401 from a failed WebSocket handshake — it sees a
 * failed connect with no body. The protocol's documented failure signal is a
 * close code (4401), which only exists *after* a handshake. So `/ws` skips the
 * HTTP 401 and is authenticated inside `open`, where the close code can be
 * delivered. Zero application data is sent to an unauthenticated socket.
 */

export interface AuthGuardOptions {
  /** True when the request targets the static frontend rather than an API. */
  isStaticAsset?: (pathname: string) => boolean;
  token: string;
  /** Path exempted from the HTTP guard because it must close with 4401. */
  wsPath?: string;
}

const ALWAYS_OPEN = new Set(["/health"]);
const LOCAL_SESSION_PATH = "/auth/local-session";

const DEFAULT_WS_PATH = "/ws";

const PUBLIC_FRONTEND_PATHS = new Set([
  "/",
  "/login",
  "/help",
  "/favicon.ico",
  "/chorus.svg",
  "/sw.js",
  "/manifest.webmanifest",
]);

/** Explicit assets prevent a newly mounted API from inheriting a public exemption. */
export function isPublicFrontendPath(pathname: string): boolean {
  return PUBLIC_FRONTEND_PATHS.has(pathname) || pathname.startsWith("/_next/");
}

export function isLoginPath(pathname: string): boolean {
  return pathname === "/auth/login";
}

export function isPathAllowedUnauthenticated(
  pathname: string,
  method: string,
  isStaticAsset: (pathname: string) => boolean = () => false
): boolean {
  if (ALWAYS_OPEN.has(pathname)) {
    return true;
  }
  // Preflight carries no credentials by definition; not answering it would
  // break CORS rather than protect anything.
  if (method.toUpperCase() === "OPTIONS") {
    return true;
  }
  if (isLoginPath(pathname)) {
    return true;
  }
  if (pathname === LOCAL_SESSION_PATH && method.toUpperCase() === "POST") {
    return true;
  }
  return isStaticAsset(pathname);
}

function unauthorizedBody(): string {
  return JSON.stringify({
    code: "unauthorized",
    message: "authentication required",
  });
}

export function unauthorizedResponse(): Response {
  return new Response(unauthorizedBody(), {
    headers: { "content-type": "application/json" },
    status: 401,
  });
}

/**
 * Verifies whatever credential an HTTP or WS request carries.
 *
 * Two accepted forms, per spec §6.2: the HttpOnly session cookie (browsers
 * attach it to same-origin upgrades on their own) and a single-use ticket for
 * proxies that strip cookies on the upgrade.
 */
export async function verifyRequestCredential(
  request: Request,
  options: {
    requireDevice?: boolean;
    ticketOptions: TicketOptions;
    token: string;
  }
): Promise<
  | { deviceId?: string; ok: true; via: "cookie" | "ticket" }
  | { ok: false; reason: string }
> {
  // An explicitly presented single-use ticket is the credential for proxy
  // upgrades. Consume and verify it even when a session cookie is also present;
  // otherwise a ticket bound to another device could be ignored in favor of the
  // cookie and appear to have authenticated successfully.
  if (new URL(request.url).searchParams.has("ticket")) {
    const ticketResult = consumeRequestTicket(
      request,
      await deviceIdFromHeader(request.headers.get("cookie"), options.token),
      options
    );
    if (ticketResult) {
      return ticketResult;
    }
  }

  const device = await deviceIdFromHeader(
    request.headers.get("cookie"),
    options.token
  );
  const cookie = readSessionCookie(request.headers.get("cookie"));

  if (cookie) {
    const sessionResult = await verifySessionCredential(
      cookie,
      device,
      options
    );
    if (sessionResult) {
      return sessionResult;
    }
  }

  return { ok: false, reason: cookie ? "session invalid" : "no credential" };
}

interface CredentialOptions {
  requireDevice?: boolean;
  ticketOptions: TicketOptions;
  token: string;
}

async function verifySessionCredential(
  cookie: string,
  device: Awaited<ReturnType<typeof deviceIdFromHeader>>,
  options: CredentialOptions
) {
  const session = await verifySessionCookie(cookie, { token: options.token });
  if (!session.ok) {
    return null;
  }
  if (options.requireDevice && !device.ok) {
    return { ok: false as const, reason: "device identity missing or invalid" };
  }
  return {
    ...(device.ok ? { deviceId: device.deviceId } : {}),
    ok: true as const,
    via: "cookie" as const,
  };
}

function consumeRequestTicket(
  request: Request,
  device: Awaited<ReturnType<typeof deviceIdFromHeader>>,
  options: CredentialOptions
) {
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (ticket === null) {
    return null;
  }
  // Consumption deletes before deciding, so a replay cannot win a race.
  const outcome = consumeTicketIdentity(
    ticket,
    device.ok
      ? { ...options.ticketOptions, deviceId: device.deviceId }
      : options.ticketOptions
  );
  if (outcome.result !== "consumed") {
    return { ok: false as const, reason: `ticket ${outcome.result}` };
  }
  const deviceId = device.ok ? device.deviceId : outcome.deviceId;
  if (options.requireDevice && !deviceId) {
    return { ok: false as const, reason: "ticket device identity missing" };
  }
  return {
    ...(deviceId ? { deviceId } : {}),
    ok: true as const,
    via: "ticket" as const,
  };
}

/**
 * Scoped guard for every protected HTTP route.
 *
 * The check is the *full* credential verify — HMAC over the cookie or single-use
 * ticket consumption — not a presence check. A presence check would wave through
 * an expired or forged cookie, which is worse than having no guard at all
 * because it reads as protection.
 *
 * `onBeforeHandle` can await, so the verify happens inline.
 *
 * Must be `.use()`d **before** the routes it protects.
 */
/**
 * The guard hook, for direct registration on the main chain.
 *
 * Registered as `resolve` rather than `onBeforeHandle` because validation runs
 * in between: `onBeforeHandle` is *after* body/query validation, so a route
 * declaring `query: { directory }` answered 422 for a missing parameter before
 * the guard ever saw it — an unauthenticated caller could enumerate route
 * schemas from the status code. `resolve` runs before validation.
 *
 * Two hard-won Elysia constraints, both load-bearing:
 *
 * - `resolve` must short-circuit with `status(...)`. It merges its return value
 *   into the context with `Object.assign`, so a raw `Response` has no own
 *   enumerable properties, the assignment is a no-op, and **the handler still
 *   runs**. A guard written that way looks correct and protects nothing.
 * - The hook must be registered inline on the chain, before the routes, and not
 *   wrapped in a `.use()`-d plugin. A hook arriving via `.use()` does not
 *   propagate into nested route plugins, and routes already registered do not
 *   pick it up at all. The failure is silent in every case.
 *
 * `auth-matrix.test.ts` exists precisely because of those failure modes: they
 * all look like a working guard in code review.
 */
export function authGuardHandler(options: {
  isStaticAsset?: (pathname: string) => boolean;
  ticketOptions: TicketOptions;
  token: string;
  wsPath?: string;
}) {
  const isStaticAsset = options.isStaticAsset ?? (() => false);
  const wsPath = options.wsPath ?? DEFAULT_WS_PATH;

  return async ({ request }: { request: Request }) => {
    const { pathname } = new URL(request.url);

    if (pathname === wsPath) {
      // Authenticated in `open` so the failure can be reported as 4401 rather
      // than a handshake error the browser cannot read.
      return {};
    }

    if (isPathAllowedUnauthenticated(pathname, request.method, isStaticAsset)) {
      return {};
    }

    const result = await verifyRequestCredential(request, {
      ticketOptions: options.ticketOptions,
      token: options.token,
    });

    if (!result.ok) {
      return status(401, {
        code: "unauthorized",
        message: "authentication required",
      });
    }

    return {};
  };
}
