/**
 * CORS policy (spec §6.3, plan P4.5).
 *
 * The dangerous default here is doing nothing: `@elysiajs/cors` mounted with no
 * options reflects the request `Origin` back with credentials allowed, which is
 * equivalent to no same-origin policy at all. Since the session cookie is
 * `SameSite=Strict`, a hostile page cannot read it cross-site — but the browser
 * will still send *simple* requests and the server should not be answering them.
 *
 * Production is same-origin only, expressed as "emit no CORS headers" rather
 * than as a reflected allowlist. There is no header for 'only my own origin':
 * the absence of `Access-Control-Allow-Origin` is what makes the browser refuse.
 */

export interface CorsPolicy {
  /** Origins permitted to make credentialed cross-origin requests. */
  allowedOrigins: string[];
  isProduction: boolean;
}

export interface CorsEnvironment {
  corsAllowedOrigins?: string | undefined;
  isProduction: boolean;
}

/** Parses the dev-only allowlist. Empty/blank entries are dropped. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export class CorsMisconfigurationError extends Error {
  constructor() {
    super(
      "CORS_ALLOWED_ORIGINS must not be set in production: production is same-origin only. Remove it from the environment."
    );
    this.name = "CorsMisconfigurationError";
  }
}

/**
 * Resolves the policy, refusing the configuration the plan forbids.
 *
 * A hard failure rather than a warning: silently ignoring the variable would
 * leave an operator believing cross-origin access worked when it did not, and
 * the natural "fix" is to make it work.
 */
export function resolveCorsPolicy(env: CorsEnvironment): CorsPolicy {
  const parsed = parseAllowedOrigins(env.corsAllowedOrigins);

  if (env.isProduction && parsed.length > 0) {
    throw new CorsMisconfigurationError();
  }

  return { allowedOrigins: parsed, isProduction: env.isProduction };
}

/**
 * CORS options for `@elysiajs/cors`, or `undefined` for "no plugin".
 *
 * In production the plugin is not mounted at all, which is the strongest
 * statement available: no preflight succeeds, and no origin is ever echoed.
 */
export function corsOptionsFor(policy: CorsPolicy) {
  if (policy.isProduction || policy.allowedOrigins.length === 0) {
    return undefined;
  }

  return {
    // The key is `origin`, not `allow`. An unrecognised key is silently ignored
    // and the plugin then falls back to reflecting whatever `Origin` the caller
    // sent — so a typo here produced a permissive policy while still looking
    // configured. Verified against the installed 1.4.1 typings.
    origin: policy.allowedOrigins,
    // The session cookie is the credential, so it must travel when the dev
    // frontend on :3000 talks to serve on :2000.
    credentials: true,
    maxAge: 86_400,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
  };
}
