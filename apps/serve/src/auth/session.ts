import type { SessionRegistry } from "./session-registry";

const KEY_LABEL = "chorus-session";

export const SESSION_COOKIE = "chorus_session";
export const SECURE_SESSION_COOKIE = "__Host-chorus_session";

export const SESSION_TTL_SECONDS = 2_592_000;

const SESSION_VERSION = "v1";

const KEY_LENGTH_BITS = 256;

export type SessionKeyUsage = "sign" | "verify";

export interface SessionOptions {
  deviceLabel?: string;
  now?: () => number;
  registry?: SessionRegistry;

  token: string;
}

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
  cookie: string;
  deviceId?: string;

  expiresAt: number;
}

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

function payloadFor(expiresAt: number): Uint8Array<ArrayBuffer> {
  return bytesOf(`chorus-session-v1:${expiresAt}`);
}

function toBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function issueSessionCookie(
  options: SessionOptions,
  ttlSeconds: number = SESSION_TTL_SECONDS
): Promise<IssuedSession> {
  const now = options.now ?? Date.now;
  const expiresAt = now() + ttlSeconds * 1000;
  if (options.registry) {
    const issued = options.registry.issue(expiresAt, options.deviceLabel);
    return {
      cookie: `v2.${issued.credential}`,
      expiresAt,
      deviceId: issued.deviceId,
    };
  }
  const key = await deriveSessionKey(options.token);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    payloadFor(expiresAt)
  );

  // The version prefix is load-bearing: `verifySessionCookie` rejects a cookie

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
  | { ok: true; expiresAt: number; deviceId?: string }
  | { ok: false; reason: VerifyFailure };

export async function verifySessionCookie(
  cookie: string | undefined | null,
  options: SessionOptions
): Promise<VerifyResult> {
  if (!cookie) {
    return { ok: false, reason: "malformed" };
  }

  if (options.registry) {
    const [version, credential, extra] = cookie.split(".");
    if (version !== "v2" || !credential || extra !== undefined) {
      return { ok: false, reason: "unsupported-version" };
    }
    const session = options.registry.verify(credential);
    return session
      ? { ok: true, expiresAt: session.expiresAt, deviceId: session.deviceId }
      : { ok: false, reason: "signature" };
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

export function readSessionCookie(
  header: string | null | undefined
): string | null {
  if (!header) {
    return null;
  }

  for (const name of [SECURE_SESSION_COOKIE, SESSION_COOKIE]) {
    const parts = header
      .split(";")
      .filter(
        (part) =>
          part.indexOf("=") > 0 &&
          part.slice(0, part.indexOf("=")).trim() === name
      );
    if (parts.length > 1) {
      return null;
    }
    const part = parts[0];
    if (part) {
      try {
        return decodeURIComponent(part.slice(part.indexOf("=") + 1).trim());
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function buildSessionCookieHeader(
  cookie: string,
  expiresAt: number,
  secure: boolean
): string {
  const attributes = [
    `${secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE}=${cookie}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  attributes.push(`Expires=${new Date(expiresAt).toUTCString()}`);

  return attributes.join("; ");
}

export function buildClearedCookieHeader(secure: boolean): string {
  const attributes = [
    `${secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE}=`,
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

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);

  if (left.length !== right.length) {
    return false;
  }

  // A constant-time compare is the whole reason for this loop: `!==`

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: see above
    difference |= (left[index] as number) ^ (right[index] as number);
  }

  return difference === 0;
}
