import { createHash, createHmac, randomBytes } from "node:crypto";
import { MAX_PAIRED_DEVICES } from "@chorus/contracts";
import { z } from "zod";
import { newDeviceId } from "./device";
import type { TicketStore } from "./ticket";

const SESSION_PREFIX = "sessions:v2:";
const DEVICE_PREFIX = "devices:v2:";
const SESSION_SHAPE = /^[a-f0-9]{64}$/;
const DEVICE_SHAPE = /^[a-f0-9]{32}$/;
const sessionSchema = z.strictObject({
  deviceId: z.string().regex(DEVICE_SHAPE),
  expiresAt: z.number().int().positive(),
});
const deviceSchema = z.strictObject({
  createdAt: z.number().int().nonnegative(),
  deviceId: z.string().regex(DEVICE_SHAPE),
  label: z.string().max(80),
  expiresAt: z.number().int().positive(),
  revokedAt: z.number().int().nonnegative().nullable(),
});

/** Hashed opaque credentials, separate per browser and immediately revocable. */
export class DeviceLimitError extends Error {
  constructor() {
    super("Disconnect a paired device before connecting another.");
    this.name = "DeviceLimitError";
  }
}

export class SessionRegistry {
  readonly #store: TicketStore;
  readonly #now: () => number;
  readonly #sessionPrefix: string;
  readonly #devicePrefix: string;

  constructor(store: TicketStore, signingSecret: string, now = Date.now) {
    this.#store = store;
    this.#now = now;
    const scope = createHmac("sha256", signingSecret)
      .update("chorus-session-registry:v2")
      .digest("hex");
    this.#sessionPrefix = `${SESSION_PREFIX}${scope}:`;
    this.#devicePrefix = `${DEVICE_PREFIX}${scope}:`;
  }

  issue(expiresAt: number, label = "Browser") {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.#now()) {
      throw new Error("session expiry must be in the future");
    }
    this.prune();
    // Bound authenticated credential creation as well as login brute force.
    if (
      this.list().filter((device) => device.revokedAt === null).length >=
      MAX_PAIRED_DEVICES
    ) {
      throw new DeviceLimitError();
    }
    const credential = randomBytes(32).toString("hex");
    const deviceId = newDeviceId();
    this.#store.setMeta(
      `${this.#devicePrefix}${deviceId}`,
      JSON.stringify({
        deviceId,
        label: label.slice(0, 80),
        createdAt: this.#now(),
        expiresAt,
        revokedAt: null,
      })
    );
    this.#store.setMeta(
      this.#sessionKey(credential),
      JSON.stringify({ deviceId, expiresAt })
    );
    return { credential, deviceId, expiresAt };
  }

  verify(credential: string) {
    if (!SESSION_SHAPE.test(credential)) {
      return null;
    }
    const raw = this.#store.getMeta(this.#sessionKey(credential));
    if (!raw) {
      return null;
    }
    try {
      const session = sessionSchema.parse(JSON.parse(raw));
      return session.expiresAt > this.#now() &&
        this.deviceAllowed(session.deviceId)
        ? session
        : null;
    } catch {
      return null;
    }
  }

  deviceAllowed(deviceId: string): boolean {
    if (!DEVICE_SHAPE.test(deviceId)) {
      return false;
    }
    const raw = this.#store.getMeta(`${this.#devicePrefix}${deviceId}`);
    if (!raw) {
      return false;
    }
    try {
      const device = deviceSchema.parse(JSON.parse(raw));
      return device.revokedAt === null && device.expiresAt > this.#now();
    } catch {
      return false;
    }
  }

  list(): z.infer<typeof deviceSchema>[] {
    return this.#store
      .entriesWithPrefix(this.#devicePrefix)
      .map(([, raw]) => deviceSchema.parse(JSON.parse(raw)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  revokeDevice(deviceId: string): boolean {
    if (!DEVICE_SHAPE.test(deviceId)) {
      return false;
    }
    const raw = this.#store.getMeta(`${this.#devicePrefix}${deviceId}`);
    if (!raw) {
      return false;
    }
    const device = deviceSchema.parse(JSON.parse(raw));
    this.#store.setMeta(
      `${this.#devicePrefix}${deviceId}`,
      JSON.stringify({ ...device, revokedAt: this.#now() })
    );
    for (const [key, sessionRaw] of this.#store.entriesWithPrefix(
      this.#sessionPrefix
    )) {
      const session = sessionSchema.parse(JSON.parse(sessionRaw));
      if (session.deviceId === deviceId) {
        this.#store.deleteMeta(key);
      }
    }
    return true;
  }

  prune(): void {
    const active = new Set<string>();
    for (const [key, raw] of this.#store.entriesWithPrefix(SESSION_PREFIX)) {
      const session = sessionSchema.parse(JSON.parse(raw));
      if (session.expiresAt <= this.#now()) {
        this.#store.deleteMeta(key);
      } else {
        active.add(session.deviceId);
      }
    }
    for (const [key, raw] of this.#store.entriesWithPrefix(DEVICE_PREFIX)) {
      const device = deviceSchema.parse(JSON.parse(raw));
      if (!active.has(device.deviceId)) {
        this.#store.deleteMeta(key);
      }
    }
  }

  #sessionKey(value: string): string {
    return (
      this.#sessionPrefix + createHash("sha256").update(value).digest("hex")
    );
  }
}
