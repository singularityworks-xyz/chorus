import { Database } from "bun:sqlite";
import { createPublicKey, randomBytes } from "node:crypto";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type HostIdentity,
  hostIdentitySchema,
  type RelayMachineConnection,
  relayEnrollmentChallengeSchema,
  relayMachineConnectionSchema,
} from "@chorus/contracts";
import { SecretEnvelope } from "@chorus/security";
import { z } from "zod";
import { HostJournal } from "./journal";
import { ensurePrivateHostDirectory } from "./private-directory";
import { generateHostKey, publicKeyHash } from "./signatures";

const HEX_KEY = /^[a-f0-9]{64}$/;
const identityKeySchema = hostIdentitySchema.extend({
  privateKey: z.string().min(1),
});

async function readWrappingKey(root: string): Promise<string> {
  const filename = join(root, "wrapping.key");
  try {
    const file = await open(filename, "wx", 0o600);
    try {
      await file.writeFile(randomBytes(32).toString("hex"));
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
  }
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("The host wrapping material is not a private regular file");
  }
  await chmod(filename, 0o600);
  const value = (await readFile(filename, "utf8")).trim();
  if (!HEX_KEY.test(value)) {
    throw new Error(
      "The host wrapping material is corrupt; refusing to replace it"
    );
  }
  return value;
}

/** Credentials never enter chorus.db, workspace events, or browser storage. */
export class HostVault {
  readonly #db: Database;
  readonly #envelope: SecretEnvelope;
  readonly #root: string;

  private constructor(root: string, wrappingKey: string) {
    this.#root = root;
    this.#envelope = new SecretEnvelope(wrappingKey, "host-credentials:v1");
    this.#db = new Database(join(root, "vault.db"), { create: true });
    this.#db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sealed (id TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
  }

  static async open(directory: string): Promise<HostVault> {
    const root = await ensurePrivateHostDirectory(directory);
    const wrappingKey = await readWrappingKey(root);
    const vault = new HostVault(root, wrappingKey);
    try {
      await chmod(join(root, "vault.db"), 0o600);
      vault.#identity();
      return vault;
    } catch (error) {
      vault.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  identity(): HostIdentity {
    const keys = this.#identity();
    return hostIdentitySchema.parse({
      hostId: keys.hostId,
      publicKey: keys.publicKey,
    });
  }

  sessionSigningSecret(): string {
    return this.#db
      .transaction(() => {
        let value = this.#read("browser-signing-root");
        if (!value) {
          value = randomBytes(32).toString("hex");
          this.#save("browser-signing-root", value);
        }
        if (!HEX_KEY.test(value)) {
          throw new Error("The browser signing material is corrupt");
        }
        return value;
      })
      .immediate();
  }

  journal(): HostJournal {
    const keys = this.#identity();
    return new HostJournal(this.#root, this.identity(), keys.privateKey);
  }

  connection(): RelayMachineConnection | null {
    const value = this.#read("relay-connection");
    return value ? relayMachineConnectionSchema.parse(JSON.parse(value)) : null;
  }

  saveConnection(connection: RelayMachineConnection): void {
    const parsed = relayMachineConnectionSchema.parse(connection);
    if (parsed.hostId !== this.identity().hostId) {
      throw new Error("The relay connection belongs to a different host");
    }
    const existing = this.connection();
    this.#save("relay-connection", JSON.stringify(parsed));
    if (!existing) {
      this.setRemoteEnabled(true);
    }
  }

  remoteEnabled(): boolean {
    return this.#read("relay-enabled") === "true";
  }

  setRemoteEnabled(enabled: boolean): void {
    this.#save("relay-enabled", JSON.stringify(enabled));
  }

  clearConnection(): void {
    this.#db.query("DELETE FROM sealed WHERE id='relay-connection'").run();
  }

  enrollment(): z.infer<typeof relayEnrollmentChallengeSchema> | null {
    const value = this.#read("relay-enrollment");
    return value
      ? relayEnrollmentChallengeSchema.parse(JSON.parse(value))
      : null;
  }

  saveEnrollment(input: z.infer<typeof relayEnrollmentChallengeSchema>): void {
    this.#save(
      "relay-enrollment",
      JSON.stringify(relayEnrollmentChallengeSchema.parse(input))
    );
  }

  clearEnrollment(): void {
    this.#db.query("DELETE FROM sealed WHERE id='relay-enrollment'").run();
  }

  #identity() {
    return this.#db
      .transaction(() => {
        let raw = this.#read("identity");
        if (!raw) {
          raw = JSON.stringify({
            ...generateHostKey(),
            hostId: crypto.randomUUID(),
          });
          this.#save("identity", raw);
        }
        const identity = identityKeySchema.parse(JSON.parse(raw));
        const derived = createPublicKey(identity.privateKey).export({
          format: "jwk",
        });
        if (
          derived.x !== identity.publicKey.x ||
          derived.y !== identity.publicKey.y
        ) {
          throw new Error("The host signing identity is corrupt");
        }
        // Also rejects malformed public coordinates before they can be approved.
        publicKeyHash(identity.publicKey);
        return identity;
      })
      .immediate();
  }

  #read(id: string): string | null {
    const row = this.#db
      .query<{ value: string }, [string]>("SELECT value FROM sealed WHERE id=?")
      .get(id);
    return row ? this.#envelope.open(id, row.value) : null;
  }

  #save(id: string, value: string): void {
    this.#db
      .query(
        "INSERT INTO sealed VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value"
      )
      .run(id, this.#envelope.seal(id, value));
  }
}
