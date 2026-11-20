import { status } from "elysia";
import { deviceIdFromHeader } from "./device";
import { readSessionCookie, verifySessionCookie } from "./session";
import type { SessionRegistry } from "./session-registry";
import { consumeTicketIdentity, type TicketOptions } from "./ticket";

export interface AuthGuardOptions {
  isStaticAsset?: (pathname: string) => boolean;
  token: string;

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

export async function verifyRequestCredential(
  request: Request,
  options: {
    sessionRegistry?: SessionRegistry;
    allowTicket?: boolean;
    requireDevice?: boolean;
    ticketOptions: TicketOptions;
    token: string;
  }
): Promise<
  | { deviceId?: string; ok: true; via: "cookie" | "ticket" }
  | { ok: false; reason: string }
> {
  // An explicitly presented single-use ticket is the credential for proxy

  if (
    options.allowTicket !== false &&
    new URL(request.url).searchParams.has("ticket")
  ) {
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
  sessionRegistry?: SessionRegistry;
  ticketOptions: TicketOptions;
  token: string;
}

async function verifySessionCredential(
  cookie: string,
  device: Awaited<ReturnType<typeof deviceIdFromHeader>>,
  options: CredentialOptions
) {
  const session = await verifySessionCookie(cookie, {
    token: options.token,
    registry: options.sessionRegistry,
  });
  if (!session.ok) {
    return null;
  }
  const deviceId =
    session.deviceId ?? (device.ok ? device.deviceId : undefined);
  if (options.requireDevice && !deviceId) {
    return { ok: false as const, reason: "device identity missing or invalid" };
  }
  return {
    ...(deviceId ? { deviceId } : {}),
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
  if (
    options.sessionRegistry &&
    !(deviceId && options.sessionRegistry.deviceAllowed(deviceId))
  ) {
    return { ok: false as const, reason: "device session revoked or expired" };
  }
  if (options.requireDevice && !deviceId) {
    return { ok: false as const, reason: "ticket device identity missing" };
  }
  return {
    ...(deviceId ? { deviceId } : {}),
    ok: true as const,
    via: "ticket" as const,
  };
}

export function authGuardHandler(options: {
  sessionRegistry?: SessionRegistry;
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

      return {};
    }

    if (isPathAllowedUnauthenticated(pathname, request.method, isStaticAsset)) {
      return {};
    }

    const result = await verifyRequestCredential(request, {
      allowTicket: false,
      sessionRegistry: options.sessionRegistry,
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
