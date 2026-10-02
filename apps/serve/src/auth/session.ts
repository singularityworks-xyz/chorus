/**
 * Session cookie signing (spec §6.1, plan P4.2).
 *
 * Shape: `<expiresAtBase36>.<signature>`, where the signature is
 * HMAC-SHA256 over `"chorus-session-v1:<expiresAt>"` under a key derived from
 * `CHORUS_TOKEN` via HKDF-SHA256 with the info label `chorus-session`.
 *
 * Two properties this shape is chosen for:
 *
 * - The signing key is *derived*, not the raw token. A leaked cookie therefore
 *   does not hand an attacker the token itself, and the derivation is labelled
 *   so the same token used for another purpose cannot reuse this key.
 * - Verification is `crypto.subtle.verify`, i.e. the WebCrypto HMAC comparison.
 *   Re-implementing the check as `a === b` on hex strings is the classic
 *   timing-oracle bug, and a token comparison is exactly where it is tempting.
 */

const KEY_LABEL = "chorus-session";
/** Cookie name used on both the HTTP responses and the WS upgrade. */
export const SESSION_COOKIE = "chorus_session";

/** 30 days (decision #3). */
export const SESSION_TTL_SECONDS = 2_592_000;

/** Bumped if the cookie format changes; an old cookie then fails closed. */
const SESSION_VERSION = "v1";

const KEY_LENGTH_BITS = 256;

/**
 * WebCrypto key usages, spelled locally because this project's lib config has
 * no DOM `KeyUsage`.
 */
export type SessionKeyUsage = "sign" | "verify";

export interface SessionOptions {
  now?: () => number;
  /** Injected in tests; production derives it from `CHORUS_TOKEN`. */
  token: string;
}

/**
 * Derives the session-signing key with HKDF-SHA256.
 *
 * An empty salt: the input key material is already 256 bits of CSPRNG output,
 * so a salt adds no entropy, and a fixed value would only add a field to get
 * wrong.
 */
export async function deriveSessionKey(
  token: string,
  usage: readonly SessionKeyUsage[] = ["sign", "verify"]
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    bytesOf(token),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      info: bytesOf(KEY_LABEL),
      name: "HKDF",
      salt: new Uint8Array(0),
    },
    baseKey,
    { hash: "SHA-256", length: KEY_LENGTH_BITS, name: "HMAC" },
    false,
    [...usage]
  );
}

export interface IssuedSession {
  /** Cookie value to set. */
  cookie: string;
  /** Absolute expiry in ms since epoch. */
  expiresAt: number;
}

/**
 * Copies encoded bytes into a fresh `ArrayBuffer`-backed array.
 *
 * `TextEncoder.encode` returns `Uint8Array<ArrayBufferLike>`, which no longer
 * satisfies `BufferSource` under this TypeScript version. Copying is cheap here
 * (a ~40 byte payload, once per handshake) and keeps the cast out of the code.
 */
function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

function payloadFor(expiresAt: number): Uint8Array<ArrayBuffer> {
  return bytesOf(`chorus-session-v1:${expiresAt}`);
}

function toBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Mints a signed cookie value for `ttlSeconds` from now. */
export async function issueSessionCookie(
  options: SessionOptions,
  ttlSeconds: number = SESSION_TTL_SECONDS
): Promise<IssuedSession> {
  const now = options.now ?? Date.now;
  const expiresAt = now() + ttlSeconds * 1000;
  const key = await deriveSessionKey(options.token);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    payloadFor(expiresAt)
  );

  // The version prefix is load-bearing: `verifySessionCookie` rejects a cookie
  // without it as malformed. Leaving it off made every issued cookie
  // unverifiable, which surfaced as a 401 on a correct login.
  return {
    cookie: `${SESSION_VERSION}.${expiresAt.toString(36)}.${toBase64Url(signature)}`,
    expiresAt,
  };
}

export type VerifyFailure =
  | "expired"
  | "malformed"
  | "signature"
  | "unsupported-version";

export type VerifyResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: VerifyFailure };

/**
 * Verifies a cookie value.
 *
 * Never throws and never distinguishes "never existed" from "wrong" to the
 * caller beyond a reason string the HTTP layer collapses to a flat 401, so a
 * probe cannot learn which of the two it hit.
 */
export async function verifySessionCookie(
  cookie: string | undefined | null,
  options: SessionOptions
): Promise<VerifyResult> {
  if (!cookie) {
    return { ok: false, reason: "malformed" };
  }

  const [version, expiresRaw, signature] = cookie.split(".");
  if (version !== SESSION_VERSION || !expiresRaw || !signature) {
    return { ok: false, reason: "malformed" };
  }

  const expiresAt = Number.parseInt(expiresRaw, 36);
  if (!Number.isFinite(expiresAt) || expiresAt < 0) {
    return { ok: false, reason: "malformed" };
  }

  const now = options.now ?? Date.now;
  if (now() >= expiresAt) {
    return { ok: false, reason: "expired" };
  }

  const key = await deriveSessionKey(options.token);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    Buffer.from(signature, "base64url"),
    payloadFor(expiresAt)
  );

  if (!valid) {
    return { ok: false, reason: "signature" };
  }

  return { expiresAt, ok: true };
}

/** Reads the session cookie out of a Cookie header. */
export function readSessionCookie(
  header: string | null | undefined
): string | null {
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }

  return null;
}

/** `Set-Cookie` value for issuing a session. */
export function buildSessionCookieHeader(
  cookie: string,
  expiresAt: number,
  secure: boolean
): string {
  const attributes = [
    `${SESSION_COOKIE}=${cookie}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  // `Expires` mirrors `Max-Age` for clients that ignore one of them.
  attributes.push(`Expires=${new Date(expiresAt).toUTCString()}`);

  return attributes.join("; ");
}

/** `Set-Cookie` value that clears the session. */
export function buildClearedCookieHeader(secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

/**
 * Constant-time string comparison for raw token checks.
 *
 * Used only for the login body, where the candidate arrives as a plain string
 * rather than a signed frame. Length is compared first (public information),
 * then every byte is XOR-accumulated so the loop does not short-circuit.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);

  if (left.length !== right.length) {
    return false;
  }

  // A constant-time compare is the whole reason for this loop: `!==`
  // short-circuits and leaks the position of the first differing byte.
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: see above
    difference |= (left[index] as number) ^ (right[index] as number);
  }

  return difference === 0;
}
