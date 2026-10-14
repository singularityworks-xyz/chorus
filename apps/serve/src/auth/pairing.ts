/**
 * Short-lived, single-use credentials for adding a browser to an existing
 * Chorus instance. Tokens are kept as SHA-256 digests and only in memory; a
 * server restart invalidates any outstanding code.
 */

export const DEVICE_PAIRING_TTL_MS = 300_000;

const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

export interface IssuedDevicePairingToken {
  expiresAt: number;
  token: string;
}

export class DevicePairingTokenStore {
  #pending: { digest: string; expiresAt: number } | null = null;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async issue(): Promise<IssuedDevicePairingToken> {
    this.prune();
    const token = generateDevicePairingToken();
    const digest = await digestToken(token);
    const expiresAt = this.#now() + DEVICE_PAIRING_TTL_MS;
    // A newer code replaces an unused one so an invisible stale code cannot
    // remain valid after the UI has replaced it.
    this.#pending = { digest, expiresAt };
    return { expiresAt, token };
  }

  async consume(candidate: string): Promise<boolean> {
    if (!TOKEN_SHAPE.test(candidate)) {
      return false;
    }

    const digest = await digestToken(candidate);
    if (this.#pending?.digest !== digest) {
      return false;
    }

    // Delete before returning so concurrent attempts cannot reuse a code.
    const expiresAt = this.#pending.expiresAt;
    this.#pending = null;
    return this.#now() < expiresAt;
  }

  prune(): number {
    if (this.#pending && this.#pending.expiresAt <= this.#now()) {
      this.#pending = null;
      return 1;
    }
    return 0;
  }

  get size(): number {
    return this.#pending ? 1 : 0;
  }
}

export function generateDevicePairingToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestToken(token: string): Promise<string> {
  const input = new Uint8Array(new TextEncoder().encode(token));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
