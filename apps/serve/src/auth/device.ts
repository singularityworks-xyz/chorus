const DEVICE_KEY_LABEL = "chorus-device";
const DEVICE_VERSION = "v1";
const DEVICE_ID_SHAPE = /^[0-9a-f]{32}$/;
const DEVICE_SIGNATURE_BYTES = 32;

export const DEVICE_COOKIE = "chorus_device";
export const SECURE_DEVICE_COOKIE = "__Host-chorus_device";
export const DEVICE_TTL_SECONDS = 31_536_000;

export type DeviceVerifyResult = { deviceId: string; ok: true } | { ok: false };

function bytesOf(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(value));
}

async function deriveDeviceKey(token: string): Promise<CryptoKey> {
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
      info: bytesOf(DEVICE_KEY_LABEL),
      name: "HKDF",
      salt: new Uint8Array(0),
    },
    baseKey,
    { hash: "SHA-256", length: 256, name: "HMAC" },
    false,
    ["sign", "verify"]
  );
}

function cookieValueFromHeader(header: string | null): string | null {
  if (!header) {
    return null;
  }
  for (const expected of [SECURE_DEVICE_COOKIE, DEVICE_COOKIE]) {
    const matches = header
      .split(";")
      .filter((item) => item.trim().split("=")[0] === expected);
    if (matches.length > 1) {
      return null;
    }
    const item = matches[0];
    if (item) {
      return item.slice(item.indexOf("=") + 1).trim() || null;
    }
  }
  return null;
}

export function newDeviceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function issueDeviceCookie(
  token: string,
  deviceId = newDeviceId()
): Promise<string> {
  if (!DEVICE_ID_SHAPE.test(deviceId)) {
    throw new Error("invalid device identity");
  }
  const key = await deriveDeviceKey(token);
  const payload = bytesOf(`${DEVICE_KEY_LABEL}-${DEVICE_VERSION}:${deviceId}`);
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return `${DEVICE_VERSION}.${deviceId}.${Buffer.from(signature).toString("base64url")}`;
}

export async function verifyDeviceCookie(
  cookie: string | null | undefined,
  token: string
): Promise<DeviceVerifyResult> {
  if (!cookie) {
    return { ok: false };
  }
  const [version, deviceId, encodedSignature, extra] = cookie.split(".");
  if (
    version !== DEVICE_VERSION ||
    !deviceId ||
    !DEVICE_ID_SHAPE.test(deviceId) ||
    !encodedSignature ||
    extra !== undefined
  ) {
    return { ok: false };
  }

  try {
    const signature = Buffer.from(encodedSignature, "base64url");
    if (signature.byteLength !== DEVICE_SIGNATURE_BYTES) {
      return { ok: false };
    }
    const key = await deriveDeviceKey(token);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      bytesOf(`${DEVICE_KEY_LABEL}-${DEVICE_VERSION}:${deviceId}`)
    );
    return valid ? { deviceId, ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function deviceIdFromHeader(
  header: string | null,
  token: string
): Promise<DeviceVerifyResult> {
  const value = cookieValueFromHeader(header);
  return verifyDeviceCookie(value, token);
}

export function buildDeviceCookieHeader(
  value: string,
  isProduction: boolean
): string {
  const attributes = [
    `${isProduction ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${String(DEVICE_TTL_SECONDS)}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (isProduction) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}
