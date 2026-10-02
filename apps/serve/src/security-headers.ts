/**
 * Content-Security-Policy for the static frontend (plan P4.4).
 *
 * `default-src 'self'` with the minimum additions the app actually needs:
 *
 * - `script-src`/`style-src` need `'unsafe-inline'` because the Next.js static
 *   export inlines bootstrap scripts and styles. `'unsafe-eval'` is **not**
 *   granted — the plan forbids it, and the production build does not need it.
 *   If a future framework change demands `eval`, that is a signal to change the
 *   framework, not to weaken this header.
 * - `connect-src` includes `ws:`/`wss:` because the state channel is a
 *   WebSocket to this same origin.
 * - `img-src 'self' data:` covers inline data-URI avatars/icons and nothing
 *   remote.
 *
 * `frame-ancestors 'none'` and `object-src 'none'` are cheap and close off
 * clickjacking and plugin content.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/**
 * The header bag shape Elysia's `set.headers` provides.
 *
 * A plain record, not a `Headers` instance — hence the index assignment rather
 * than `.set()`.
 */
export type HeaderBag = Record<string, unknown>;

/** The header set every response carries. */
export function hardeningHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  };
}

/**
 * Writes the hardening headers into an outgoing header bag.
 *
 * Used from Elysia's `onRequest`, which is the only hook that reaches every
 * response path: a normal 200, a 401 short-circuit from the auth guard, and a
 * 404 from the SPA fallback.
 */
export function applySecurityHeaders(headers: HeaderBag): void {
  for (const [name, value] of Object.entries(hardeningHeaders())) {
    headers[name] = value;
  }
}

/** Applies the policy (and the headers it implies) to a response. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(hardeningHeaders())) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
