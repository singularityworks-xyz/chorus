import { LOCAL_ENTRY_PORT } from "@chorus/contracts";
import { Elysia, status } from "elysia";
import { applySecurityHeaders } from "../security-headers";
import { isLoopbackAddress } from "./local-access";
import { clientIp } from "./routes";
import {
  issueSessionCookie,
  readSessionCookie,
  SESSION_TTL_SECONDS,
  verifySessionCookie,
} from "./session";
import { sessionHeaders } from "./session-headers";
import { DeviceLimitError, type SessionRegistry } from "./session-registry";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const ALLOWED_HEADERS = new Set(["x-chorus-local-bootstrap", "content-type"]);

export function localEntryRequestAllowed(
  request: Request,
  peerAddress: string,
  webPort: number
): boolean {
  const origin = request.headers.get("origin");
  if (!(origin && URL.canParse(origin) && isLoopbackAddress(peerAddress))) {
    return false;
  }
  const page = new URL(origin);
  const target = new URL(request.url);
  return (
    page.origin === origin &&
    page.protocol === "http:" &&
    LOCAL_HOSTS.has(page.hostname) &&
    page.hostname === target.hostname &&
    page.port === String(webPort)
  );
}

/** Only this separate 127.0.0.1 listener can create installed local sessions. */
export function createLocalEntry(options: {
  token: string;
  registry: SessionRegistry;
  webPort?: number;
}) {
  const sessionOptions = { token: options.token, registry: options.registry };
  return new Elysia({ serve: { maxRequestBodySize: 1024 } })
    .onRequest(({ request, server, set }) => {
      applySecurityHeaders(set.headers);
      set.headers["cache-control"] = "no-store";
      if (
        !localEntryRequestAllowed(
          request,
          clientIp(server ?? null, request),
          options.webPort ?? 3000
        )
      ) {
        return status(403, { code: "local_entry_unavailable" });
      }
      set.headers["access-control-allow-origin"] =
        request.headers.get("origin") ?? "";
      set.headers["access-control-allow-credentials"] = "true";
      set.headers.vary = "Origin";
      if (request.method === "OPTIONS") {
        const headers = (
          request.headers.get("access-control-request-headers") ?? ""
        )
          .split(",")
          .map((header) => header.trim().toLowerCase())
          .filter(Boolean);
        if (
          request.headers.get("access-control-request-method") !== "POST" ||
          headers.some((header) => !ALLOWED_HEADERS.has(header))
        ) {
          return status(403, { code: "local_entry_unavailable" });
        }
        set.headers["access-control-allow-methods"] = "POST";
        set.headers["access-control-allow-headers"] =
          "x-chorus-local-bootstrap, content-type";
        return new Response(null, { status: 204 });
      }
      if (
        request.method !== "POST" ||
        request.headers.get("x-chorus-local-bootstrap") !== "1"
      ) {
        return status(403, { code: "local_entry_unavailable" });
      }
    })
    .onError(({ error, set }) => {
      set.status = error instanceof DeviceLimitError ? 409 : 503;
      return {
        code:
          error instanceof DeviceLimitError
            ? "device_limit_reached"
            : "local_entry_unavailable",
      };
    })
    .options("/auth/local-session", () => new Response(null, { status: 204 }))
    .post("/auth/local-session", async ({ request, set }) => {
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
        true
      );
      return { authenticated: true, expiresAt: session.expiresAt };
    });
}

export function startLocalEntry(
  options: Parameters<typeof createLocalEntry>[0]
) {
  return createLocalEntry(options).listen({
    hostname: "127.0.0.1",
    port: LOCAL_ENTRY_PORT,
  });
}
