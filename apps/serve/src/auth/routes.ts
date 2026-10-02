import { Elysia, t } from "elysia";
import { LoginRateLimiter } from "./brute-force";
import {
  buildClearedCookieHeader,
  buildSessionCookieHeader,
  issueSessionCookie,
  SESSION_TTL_SECONDS,
  timingSafeEqualStrings,
} from "./session";
import { issueTicket, type TicketStore } from "./ticket";

/**
 * Authentication routes (spec §6.1, plan P4.2/P4.3).
 *
 * `POST /auth/login` is the only way in, and it is the only unauthenticated
 * route that can *do* anything: it exchanges the operator's token for a
 * session cookie so the raw token never has to be carried by browser code on
 * every subsequent request (spec §6.2).
 */

export interface AuthRouteOptions {
  isProduction: boolean;
  now?: () => number;
  rateLimiter?: LoginRateLimiter;
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

  return new Elysia()
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

        if (
          candidate.length === 0 ||
          !timingSafeEqualStrings(candidate, options.token)
        ) {
          if (limiter.recordFailure(key) === "rate-limited") {
            return tooManyRequests(600);
          }
          return unauthorized();
        }

        // A success clears the window so an operator who fumbled their token ten
        // times is not left locked out for the next ten minutes.
        limiter.reset(key);

        const session = await issueSessionCookie(
          { now, token: options.token },
          SESSION_TTL_SECONDS
        );

        set.headers["set-cookie"] = buildSessionCookieHeader(
          session.cookie,
          session.expiresAt,
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

    .post("/auth/logout", ({ set }) => {
      set.headers["set-cookie"] = buildClearedCookieHeader(
        options.isProduction
      );
      return { authenticated: false };
    })

    .get("/auth/ws-ticket", () => {
      const ticket = issueTicket({
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
