import { Elysia, t } from "elysia";
import { LoginRateLimiter } from "./brute-force";
import {
  buildDeviceCookieHeader,
  deviceIdFromHeader,
  issueDeviceCookie,
} from "./device";
import { canCreateLocalSession } from "./local-access";
import type { DevicePairingTokenStore } from "./pairing";
import {
  buildClearedCookieHeader,
  issueSessionCookie,
  readSessionCookie,
  SESSION_TTL_SECONDS,
  timingSafeEqualStrings,
  verifySessionCookie,
} from "./session";
import { sessionHeaders } from "./session-headers";
import { DeviceLimitError, type SessionRegistry } from "./session-registry";
import { issueTicket, type TicketStore } from "./ticket";

/**
 * Authentication routes (spec §6.1, plan P4.2/P4.3).
 *
 * `POST /auth/login` accepts an operator token or a single-use device code.
 * Local development also has a loopback-only session bootstrap; it cannot be
 * used from a remote device or in production. Successful entry points issue
 * the same HttpOnly session cookie so raw credentials do not travel with later
 * browser requests (spec §6.2).
 */

export interface AuthRouteOptions {
  isProduction: boolean;
  localOrigins: readonly string[];
  now?: () => number;
  onLogoutDevice?: (deviceId: string) => Promise<void>;
  pairingTokenStore: DevicePairingTokenStore;
  rateLimiter?: LoginRateLimiter;
  sessionRegistry?: SessionRegistry;
  ticketStore: TicketStore;
  token: string;
}

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      code: "rate_limited",
      message: "too many login attempts",
    }),
    {
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfterSeconds),
      },
      status: 429,
    }
  );
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ code: "unauthorized", message: "invalid token" }),
    {
      headers: { "content-type": "application/json" },
      status: 401,
    }
  );
}

export function createAuthRoutes(options: AuthRouteOptions) {
  const now = options.now ?? Date.now;
  const limiter = options.rateLimiter ?? new LoginRateLimiter({ now });
  const sessionOptions = {
    now,
    token: options.token,
    registry: options.sessionRegistry,
  };

  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof DeviceLimitError) {
        set.status = 409;
        return { code: "device_limit_reached", message: error.message };
      }
    })
    .post("/auth/local-session", async ({ request, set, server }) => {
      set.headers["cache-control"] = "no-store";

      if (
        !canCreateLocalSession({
          isProduction: options.isProduction,
          localOrigins: options.localOrigins,
          origin: request.headers.get("origin"),
          peerAddress: clientIp(server ?? null, request),
          requestMarker: request.headers.get("x-chorus-local-bootstrap"),
        })
      ) {
        set.status = 403;
        return { code: "local_sign_in_unavailable" };
      }

      const existing = await verifySessionCookie(
        readSessionCookie(request.headers.get("cookie")),
        sessionOptions
      );
      if (existing.ok) {
        return { authenticated: true, expiresAt: existing.expiresAt };
      }

      const session = await issueSessionCookie(
        sessionOptions,
        SESSION_TTL_SECONDS
      );
      set.headers["set-cookie"] = await sessionHeaders(
        session,
        options.token,
        options.isProduction
      );
      return { authenticated: true, expiresAt: session.expiresAt };
    })

    .post("/auth/device-pairing", async ({ request, set }) => {
      set.headers["cache-control"] = "no-store";
      const session = await verifySessionCookie(
        readSessionCookie(request.headers.get("cookie")),
        sessionOptions
      );
      if (!session.ok) {
        set.status = 401;
        return { code: "unauthorized", message: "authentication required" };
      }

      return options.pairingTokenStore.issue();
    })

    .post(
      "/auth/login",
      async ({ body, request, set, server }) => {
        // `body` is already parsed by the schema below. Calling
        // `request.json()` again throws "body already read", which silently
        // turned every login into a rejection — including the correct token.
        const candidate = typeof body?.token === "string" ? body.token : "";

        // Checked before comparing so a flood costs no HMAC work, only the
        // window arithmetic. Keyed on the peer address.
        const key = clientIp(server ?? null, request);
        if (limiter.isBlocked(key) === "rate-limited") {
          limiter.prune();
          return tooManyRequests(600);
        }

        const matchesInstanceToken =
          candidate.length > 0 &&
          timingSafeEqualStrings(candidate, options.token);
        const matchesPairingToken =
          !matchesInstanceToken &&
          (await options.pairingTokenStore.consume(candidate));

        if (!(matchesInstanceToken || matchesPairingToken)) {
          if (limiter.recordFailure(key) === "rate-limited") {
            return tooManyRequests(600);
          }
          return unauthorized();
        }

        // A success clears the window so an operator who fumbled their token ten
        // times is not left locked out for the next ten minutes.
        limiter.reset(key);

        const session = await issueSessionCookie(
          sessionOptions,
          SESSION_TTL_SECONDS
        );

        set.headers["set-cookie"] = await sessionHeaders(
          session,
          options.token,
          options.isProduction
        );

        return {
          authenticated: true,
          expiresAt: session.expiresAt,
        };
      },
      {
        body: t.Object({ token: t.String() }),
      }
    )

    .post("/auth/logout", async ({ request, set }) => {
      const session = await verifySessionCookie(
        readSessionCookie(request.headers.get("cookie")),
        sessionOptions
      );
      const device = await deviceIdFromHeader(
        request.headers.get("cookie"),
        options.token
      );
      let deviceId = device.ok ? device.deviceId : undefined;
      if (options.sessionRegistry) {
        deviceId = session.ok ? session.deviceId : undefined;
      }
      if (deviceId && options.sessionRegistry) {
        options.sessionRegistry.revokeDevice(deviceId);
      }
      if (deviceId && options.onLogoutDevice) {
        try {
          await options.onLogoutDevice(deviceId);
        } catch {
          set.status = 503;
          set.headers["set-cookie"] = buildClearedCookieHeader(
            options.isProduction
          );
          return {
            authenticated: false,
            code: "logout_cleanup_failed",
          };
        }
      }
      set.headers["set-cookie"] = buildClearedCookieHeader(
        options.isProduction
      );
      return { authenticated: false };
    })

    .post("/auth/device", async ({ request, set }) => {
      const session = await verifySessionCookie(
        readSessionCookie(request.headers.get("cookie")),
        sessionOptions
      );
      if (!session.ok) {
        set.status = 401;
        return { code: "unauthorized", message: "authentication required" };
      }

      const existing = await deviceIdFromHeader(
        request.headers.get("cookie"),
        options.token
      );
      if (
        existing.ok &&
        (!session.deviceId || session.deviceId === existing.deviceId)
      ) {
        return { deviceId: existing.deviceId };
      }

      const cookie = await issueDeviceCookie(options.token, session.deviceId);
      const deviceId = cookie.split(".")[1];
      if (!deviceId) {
        set.status = 500;
        return { code: "device_identity_failed" };
      }
      set.headers["set-cookie"] = buildDeviceCookieHeader(
        cookie,
        options.isProduction
      );
      return { deviceId };
    })

    .get("/auth/ws-ticket", async ({ request, set }) => {
      const session = await verifySessionCookie(
        readSessionCookie(request.headers.get("cookie")),
        sessionOptions
      );
      const device = await deviceIdFromHeader(
        request.headers.get("cookie"),
        options.token
      );
      if (
        !device.ok ||
        (options.sessionRegistry &&
          (!session.ok || session.deviceId !== device.deviceId))
      ) {
        set.status = 401;
        set.headers["cache-control"] = "no-store";
        return { code: "device_identity_required" };
      }

      set.headers["cache-control"] = "no-store";

      const ticket = issueTicket({
        deviceId: device.deviceId,
        now,
        store: options.ticketStore,
      });

      // Returned in the body because the caller must present it, and it is
      // single-use with a five-minute TTL, so its exposure window is small.
      return { ticket };
    });
}

/**
 * The rate-limit key for a request.
 *
 * Only the direct socket peer counts. `X-Forwarded-For` is client-supplied, so
 * honouring it would let an attacker rotate the key at will and defeat the
 * guard; an operator behind Caddy would need the proxy's real address, which is
 * a Phase 8 concern (see the runbook) rather than something to fake here.
 */
export function clientIp(
  server: {
    requestIP?: (request: Request) => { address: string } | null;
  } | null,
  request: Request
): string {
  try {
    return server?.requestIP?.(request)?.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
