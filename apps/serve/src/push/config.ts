import { generateVAPIDKeys } from "web-push-neo";
import { z } from "zod";
import type { MetaChange } from "../workspace/db";

const PERSISTED_KEYS_KEY = "push:v1:vapid-keys";
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const configurationQueues = new WeakMap<PushConfigStore, Promise<void>>();

const storedKeysSchema = z.object({
  keyId: z.string().regex(/^[0-9a-f]{24}$/),
  privateKey: z.string().min(1),
  publicKey: z.string().min(1),
  subject: z.string().min(1),
});

export interface PushEnvironment {
  enabled?: string;
  privateKey?: string;
  publicKey?: string;
  subject?: string;
}

export interface PushConfigStore {
  getMeta(key: string): string | null;
  persistMetaChanges(changes: MetaChange[]): Promise<void>;
}

export interface PushConfiguration {
  enabled: boolean;
  keyId: string | null;
  privateKey: string | null;
  publicKey: string | null;
  subject: string | null;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_KEY_PATTERN.test(value)) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    const copy = new Uint8Array(new ArrayBuffer(decoded.byteLength));
    copy.set(decoded);
    return copy;
  } catch {
    return null;
  }
}

async function validateKeyPair(
  publicKey: string,
  privateKey: string
): Promise<void> {
  const publicBytes = decodeBase64Url(publicKey);
  const privateBytes = decodeBase64Url(privateKey);
  if (
    !publicBytes ||
    publicBytes.length !== 65 ||
    publicBytes[0] !== 4 ||
    !privateBytes ||
    ![32, 138].includes(privateBytes.length)
  ) {
    throw new Error(
      "VAPID keys must be a P-256 public key and a raw or PKCS#8 private key encoded as base64url"
    );
  }

  try {
    const publicCryptoKey = await crypto.subtle.importKey(
      "raw",
      publicBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const privateCryptoKey =
      privateBytes.length === 32
        ? await crypto.subtle.importKey(
            "jwk",
            {
              crv: "P-256",
              d: Buffer.from(privateBytes).toString("base64url"),
              kty: "EC",
              x: Buffer.from(publicBytes.subarray(1, 33)).toString("base64url"),
              y: Buffer.from(publicBytes.subarray(33, 65)).toString(
                "base64url"
              ),
            },
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["sign"]
          )
        : await crypto.subtle.importKey(
            "pkcs8",
            privateBytes,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["sign"]
          );
    const challenge = new TextEncoder().encode("chorus-vapid-key-check");
    const signature = await crypto.subtle.sign(
      { hash: "SHA-256", name: "ECDSA" },
      privateCryptoKey,
      challenge
    );
    const matches = await crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      publicCryptoKey,
      signature,
      challenge
    );
    if (!matches) {
      throw new Error("key pair mismatch");
    }
  } catch {
    throw new Error(
      "VAPID public and private keys are invalid or do not match"
    );
  }
}

function validateSubject(subject: string | undefined): string {
  if (!subject) {
    throw new Error(
      "VAPID_SUBJECT is required when web push is enabled; use a mailto: contact or HTTPS URL"
    );
  }
  try {
    const parsed = new URL(subject);
    if (
      !["https:", "mailto:"].includes(parsed.protocol) ||
      (parsed.protocol === "https:" && parsed.hostname.length === 0)
    ) {
      throw new Error("unsupported subject scheme");
    }
  } catch {
    throw new Error(
      "Invalid VAPID_SUBJECT: expected a mailto: contact or HTTPS URL"
    );
  }
  return subject;
}

async function keyIdFor(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(publicKey)
  );
  return Buffer.from(digest).toString("hex").slice(0, 24);
}

function decodeStoredKeys(
  raw: string | null
): z.infer<typeof storedKeysSchema> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = storedKeysSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function resolvePushConfiguration(
  environment: PushEnvironment,
  store: PushConfigStore
): Promise<PushConfiguration> {
  const previous = configurationQueues.get(store) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  configurationQueues.set(store, current);
  await previous;

  try {
    return await resolvePushConfigurationInTurn(environment, store);
  } finally {
    release();
    if (configurationQueues.get(store) === current) {
      configurationQueues.delete(store);
    }
  }
}

async function resolvePushConfigurationInTurn(
  environment: PushEnvironment,
  store: PushConfigStore
): Promise<PushConfiguration> {
  if (
    environment.enabled !== undefined &&
    environment.enabled !== "true" &&
    environment.enabled !== "false"
  ) {
    throw new Error('Invalid PUSH_ENABLED: expected "true" or "false"');
  }
  const hasPublicKey = Boolean(environment.publicKey);
  const hasPrivateKey = Boolean(environment.privateKey);
  if (hasPublicKey !== hasPrivateKey) {
    throw new Error(
      "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together"
    );
  }

  const enabled =
    environment.enabled === "true" ||
    (environment.enabled === undefined && hasPublicKey && hasPrivateKey);
  if (!enabled) {
    return {
      enabled: false,
      keyId: null,
      privateKey: null,
      publicKey: null,
      subject: null,
    };
  }

  const subject = validateSubject(environment.subject);
  const rawStored = store.getMeta(PERSISTED_KEYS_KEY);
  const stored = decodeStoredKeys(rawStored);
  if (rawStored && !stored) {
    throw new Error(
      "Persisted VAPID key metadata is invalid; refusing to generate replacement keys"
    );
  }
  let publicKey = environment.publicKey;
  let privateKey = environment.privateKey;

  if (stored) {
    if (
      publicKey &&
      privateKey &&
      (stored.publicKey !== publicKey || stored.privateKey !== privateKey)
    ) {
      throw new Error(
        "Configured VAPID keys differ from the persisted active pair; follow the documented push-key rotation procedure"
      );
    }
    publicKey ??= stored.publicKey;
    privateKey ??= stored.privateKey;
  }

  if (!(publicKey && privateKey)) {
    const generated = await generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
  }

  await validateKeyPair(publicKey, privateKey);
  const keyId = await keyIdFor(publicKey);
  if (!stored) {
    const persisted = {
      keyId,
      privateKey,
      publicKey,
      subject,
    };
    await store.persistMetaChanges([
      { key: PERSISTED_KEYS_KEY, value: JSON.stringify(persisted) },
    ]);
  }

  return { enabled: true, keyId, privateKey, publicKey, subject };
}
