import { cookies } from "next/headers";

/**
 * Server-side proxy to the Chorus serve process.
 *
 * One thing this must get right, learned the hard way between Phase 4 and 5:
 * **the session cookie has to travel.** Phase 4 put every serve route behind an
 * HttpOnly session cookie. A proxy that does not forward the inbound cookie gets
 * a 401 from every call — which is exactly what happened, and it is invisible
 * until you open the app against a secured server.
 *
 * The cookie is read through `next/headers` rather than threaded through each
 * caller, because there are two dozen call sites and every one of them would
 * otherwise have to be edited to pass its `Request` along. `cookies()` is async
 * in Next.js 16, which this helper already is.
 *
 * The upstream status is returned verbatim. 401 in particular is meaningful: the
 * sync layer stops reconnecting on it (plan P5 task 3), so it must not be folded
 * into a generic transport error.
 */

function getChorusServeUrl(): string {
  return process.env.CHORUS_SERVE_URL ?? "http://localhost:2000";
}

function createUrl(pathname: string): string {
  return new URL(pathname, getChorusServeUrl()).toString();
}

/**
 * Copies upstream `Set-Cookie` values onto the response.
 *
 * `Headers.get` collapses multiple cookies into one comma-joined string, which
 * browsers misparse, so `getSetCookie` is preferred where available.
 */
function copySetCookies(upstream: Response, headers: Headers): void {
  const viaGetSetCookie = (
    upstream.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();

  if (viaGetSetCookie && viaGetSetCookie.length > 0) {
    for (const value of viaGetSetCookie) {
      headers.append("set-cookie", value);
    }
    return;
  }

  const single = upstream.headers.get("set-cookie");
  if (single) {
    headers.set("set-cookie", single);
  }
}

/** The inbound `Cookie` header, or null when the client sent none. */
async function inboundCookieHeader(): Promise<string | null> {
  try {
    const jar = await cookies();
    const serialized = jar.toString();
    return serialized.length > 0 ? serialized : null;
  } catch {
    // No request scope (a test, or a call from a non-route context). Proceed
    // unauthenticated rather than throwing.
    return null;
  }
}

export async function proxyChorusJson(
  pathname: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = createUrl(pathname);

  try {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const cookie = await inboundCookieHeader();
    if (cookie) {
      headers.set("cookie", cookie);
    }

    const upstream = await fetch(url, {
      ...init,
      cache: "no-store",
      headers,
    });

    const text = await upstream.text();

    const responseHeaders = new Headers({
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    });
    copySetCookies(upstream, responseHeaders);

    return new Response(text, {
      headers: responseHeaders,
      status: upstream.status,
    });
  } catch (error) {
    console.error("Failed to connect to Chorus serve:", {
      error: error instanceof Error ? error.message : String(error),
      url,
    });

    return new Response(
      JSON.stringify({
        code: "serve_connection_error",
        message: `Failed to connect to Chorus serve at ${getChorusServeUrl()}. Make sure the serve app is running.`,
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        headers: { "content-type": "application/json" },
        status: 503,
      }
    );
  }
}

/** True when a proxied response is a session rejection rather than a real error. */
export function isUnauthorized(response: Response): boolean {
  return response.status === 401;
}

/**
 * Posts JSON to serve with an explicit cookie header.
 *
 * Used by the login route, which has no session cookie to forward yet.
 */
// biome-ignore lint/suspicious/useAwait: forwards the awaited proxy result unchanged
export async function postToServeUnauthenticated(
  pathname: string,
  body: unknown
): Promise<Response> {
  return proxyChorusJson(pathname, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}
