import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Backend-only encrypted storage; never a custom network encryption protocol. */
export class SecretEnvelope {
  readonly #key: Buffer;

  constructor(secret: string, purpose: string) {
    if (secret.length < 32 || purpose.length < 1) {
      throw new Error("a storage secret and purpose are required");
    }
    this.#key = Buffer.from(
      hkdfSync("sha256", secret, "chorus:secret-storage:v1", purpose, 32)
    );
  }

  seal(context: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64url"
    );
  }

  open(context: string, envelope: string): string {
    if (!BASE64URL.test(envelope) || envelope.length > 65_536) {
      throw new Error("invalid storage envelope");
    }
    const bytes = Buffer.from(envelope, "base64url");
    if (bytes.length < 28) {
      throw new Error("invalid storage envelope");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      bytes.subarray(0, 12)
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
}
