import { cookies, headers as requestHeaders } from "next/headers";
import { mutationOriginMatches } from "./request-origin";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function getChorusServeUrl(): string {
  return process.env.CHORUS_SERVE_URL ?? "http://localhost:2000";
}

function createUrl(pathname: string): string {
  return new URL(pathname, getChorusServeUrl()).toString();
}

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

async function inboundCookieHeader(): Promise<string | null> {
  try {
    const jar = await cookies();
    const serialized = jar.toString();
    return serialized.length > 0 ? serialized : null;
  } catch {
    return null;
  }
}

export async function proxyChorusJson(
  pathname: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!(await permittedMutationOrigin(init.method ?? "GET"))) {
    return Response.json({ code: "origin_rejected" }, { status: 403 });
  }
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

    const nullBody = NULL_BODY_STATUSES.has(upstream.status);

    return new Response(nullBody ? null : text, {
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

async function permittedMutationOrigin(method: string): Promise<boolean> {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    return true;
  }
  let inbound: Awaited<ReturnType<typeof requestHeaders>>;
  try {
    inbound = await requestHeaders();
  } catch {
    return true;
  }
  const origin = inbound.get("origin");
  const host = inbound.get("host");
  const protocol =
    inbound.get("x-forwarded-proto") ??
    (process.env.NODE_ENV === "production" ? "https" : "http");
  return mutationOriginMatches(origin, host, protocol);
}

export function isUnauthorized(response: Response): boolean {
  return response.status === 401;
}

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
