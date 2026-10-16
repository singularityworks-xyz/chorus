import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type RelayEnrollmentRequest,
  relayEnrollmentPollSchema,
  relayEnrollmentRequestSchema,
  relayMachineConnectionSchema,
} from "@chorus/contracts";
import { SecretEnvelope } from "@chorus/security";
import { z } from "zod";
import type { RelayAuth } from "./auth";
import type { RelayConfig } from "./config";
import { type RelayRegistry, RelayRegistryError } from "./registry";

const enrollmentSchema = relayEnrollmentRequestSchema.extend({
  enrollmentId: z.uuid(),
  pollDigest: z.string().length(64),
  status: z.enum(["pending", "approved", "complete", "cancelled"]),
  envelope: z.string().nullable(),
  expiresAt: z.date(),
});

const ENROLLMENT_COLUMNS = `enrollment_id AS "enrollmentId", poll_digest AS "pollDigest", host_id AS "hostId", label, public_key AS "publicKey", status, credential_envelope AS envelope, expires_at AS "expiresAt"`;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A five-minute host approval exchange. No browser receives machine credentials. */
export class RelayEnrollment {
  readonly #registry: RelayRegistry;
  readonly #auth: RelayAuth;
  readonly #config: RelayConfig;
  readonly #envelope: SecretEnvelope;

  constructor(registry: RelayRegistry, auth: RelayAuth, config: RelayConfig) {
    this.#registry = registry;
    this.#auth = auth;
    this.#config = config;
    this.#envelope = new SecretEnvelope(
      config.authSecret,
      "relay-enrollment-delivery:v1"
    );
  }

  async begin(input: RelayEnrollmentRequest) {
    const request = relayEnrollmentRequestSchema.parse(input);
    const enrollmentId = crypto.randomUUID();
    const pollSecret = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 300_000);
    await this.#registry.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(17475, 2)");
      await client.query(
        "DELETE FROM relay_enrollments WHERE expires_at < now()"
      );
      const pending = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM relay_enrollments"
      );
      if ((pending.rows[0]?.count ?? 0) >= 1000) {
        throw new RelayRegistryError("capacity");
      }
      const exists = await client.query(
        "SELECT 1 FROM relay_hosts WHERE host_id=$1 UNION ALL SELECT 1 FROM relay_enrollments WHERE host_id=$1",
        [request.hostId]
      );
      if (exists.rowCount) {
        throw new RelayRegistryError("host_conflict");
      }
      await client.query(
        "INSERT INTO relay_enrollments(enrollment_id,poll_digest,host_id,label,public_key,expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          enrollmentId,
          digest(pollSecret),
          request.hostId,
          request.label,
          JSON.stringify(request.publicKey),
          expiresAt,
        ]
      );
    });
    return {
      enrollmentId,
      pollSecret,
      expiresAt: expiresAt.getTime(),
      verificationUrl: `${this.#config.accountOrigin}/enroll/${enrollmentId}`,
    };
  }

  async describe(enrollmentId: string) {
    z.uuid().parse(enrollmentId);
    const result = await this.#registry.pool.query(
      `SELECT ${ENROLLMENT_COLUMNS} FROM relay_enrollments WHERE enrollment_id=$1 AND expires_at > now()`,
      [enrollmentId]
    );
    if (!result.rows[0]) {
      throw new RelayRegistryError("invalid_enrollment");
    }
    const row = enrollmentSchema.parse(result.rows[0]);
    return {
      enrollmentId,
      label: row.label,
      hostId: row.hostId,
      publicKey: row.publicKey,
      status: row.status,
      expiresAt: row.expiresAt.getTime(),
    };
  }

  async approve(
    enrollmentId: string,
    accountId: string,
    headers: Headers
  ): Promise<void> {
    z.uuid().parse(enrollmentId);
    let createdClientId: string | undefined;
    try {
      await this.#registry.transaction(async (client) => {
        const result = await client.query(
          `SELECT ${ENROLLMENT_COLUMNS} FROM relay_enrollments WHERE enrollment_id=$1 AND expires_at > now() FOR UPDATE`,
          [enrollmentId]
        );
        if (!result.rows[0]) {
          throw new RelayRegistryError("invalid_enrollment");
        }
        const row = enrollmentSchema.parse(result.rows[0]);
        if (row.status !== "pending") {
          throw new RelayRegistryError("invalid_enrollment");
        }
        const hostname = await this.#registry.reserveHost(client, {
          accountId,
          ...row,
        });
        const credentials = await this.#auth.createMachineClient(
          headers,
          row.hostId
        );
        createdClientId = credentials.client_id;
        await this.#registry.attachClient(
          client,
          row.hostId,
          credentials.client_id
        );
        const connection = relayMachineConnectionSchema.parse({
          audience: this.#config.tunnelAudience,
          clientId: credentials.client_id,
          clientSecret: credentials.client_secret,
          hostId: row.hostId,
          hostname,
          issuer: this.#config.issuer,
          serverUrl: this.#config.tunnelOrigin,
          tokenEndpoint: `${this.#config.issuer}/oauth2/token`,
        });
        await client.query(
          "UPDATE relay_enrollments SET status='approved',credential_envelope=$2 WHERE enrollment_id=$1",
          [
            enrollmentId,
            this.#envelope.seal(enrollmentId, JSON.stringify(connection)),
          ]
        );
      });
    } catch (error) {
      if (createdClientId) {
        // Never deliver a credential whose host reservation failed to commit.
        await this.#auth
          .disableMachineClient(headers, createdClientId)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async poll(input: unknown, acknowledge = false) {
    const request = relayEnrollmentPollSchema.parse(input);
    return await this.#registry.transaction(async (client) => {
      const result = await client.query(
        `SELECT ${ENROLLMENT_COLUMNS} FROM relay_enrollments WHERE enrollment_id=$1 AND expires_at > now() FOR UPDATE`,
        [request.enrollmentId]
      );
      if (!result.rows[0]) {
        throw new RelayRegistryError("invalid_enrollment");
      }
      const row = enrollmentSchema.parse(result.rows[0]);
      if (
        !timingSafeEqual(
          Buffer.from(row.pollDigest),
          Buffer.from(digest(request.pollSecret))
        )
      ) {
        throw new RelayRegistryError("invalid_enrollment");
      }
      if (row.status === "complete") {
        return { status: "complete" as const };
      }
      if (row.status === "pending" && !acknowledge) {
        return { status: "pending" as const };
      }
      if (row.status !== "approved" || !row.envelope) {
        throw new RelayRegistryError("invalid_enrollment");
      }
      if (acknowledge) {
        await client.query(
          "UPDATE relay_enrollments SET status='complete',credential_envelope=NULL WHERE enrollment_id=$1",
          [row.enrollmentId]
        );
        return { status: "complete" as const };
      }
      const connection = relayMachineConnectionSchema.parse(
        JSON.parse(this.#envelope.open(row.enrollmentId, row.envelope))
      );
      return { status: "approved" as const, connection };
    });
  }
}
