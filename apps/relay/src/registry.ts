import type { HostPublicKey } from "@chorus/contracts";
import { hostPublicKeySchema } from "@chorus/contracts";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { TunnelHost } from "./tunnel/policy";

export const RELAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_hosts (
  host_id UUID PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  public_key JSONB NOT NULL,
  hostname TEXT UNIQUE NOT NULL,
  client_id TEXT UNIQUE,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_hosts_account ON relay_hosts(account_id);
CREATE TABLE IF NOT EXISTS relay_connections (
  host_id UUID PRIMARY KEY REFERENCES relay_hosts(host_id) ON DELETE CASCADE,
  run_id TEXT UNIQUE NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS relay_enrollments (
  enrollment_id UUID PRIMARY KEY,
  poll_digest TEXT NOT NULL,
  host_id UUID UNIQUE NOT NULL,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  public_key JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','complete','cancelled')),
  credential_envelope TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_enrollments_expiry ON relay_enrollments(expires_at);
`;

const hostRowSchema = z.object({
  host_id: z.uuid(),
  account_id: z.string().min(1),
  client_id: z.string().nullable(),
  label: z.string().min(1).max(80),
  hostname: z.string(),
  public_key: hostPublicKeySchema,
  revoked: z.boolean(),
  online: z.boolean().default(false),
});

export type RelayHost = z.infer<typeof hostRowSchema>;

type RegistryErrorCode =
  | "host_not_found"
  | "host_limit"
  | "capacity"
  | "host_conflict"
  | "invalid_enrollment";

export class RelayRegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode) {
    super(code);
    this.code = code;
    this.name = "RelayRegistryError";
  }
}

/** Durable relay metadata only: no task state, repositories, or handoff journal. */
export class RelayRegistry {
  readonly pool: Pool;
  readonly #hostsDomain: string;
  readonly #maxHostsPerAccount: number;
  readonly #maxOnlineHosts: number;

  constructor(
    pool: Pool,
    options: {
      hostsDomain: string;
      maxHostsPerAccount: number;
      maxOnlineHosts: number;
    }
  ) {
    this.pool = pool;
    this.#hostsDomain = options.hostsDomain;
    this.#maxHostsPerAccount = options.maxHostsPerAccount;
    this.#maxOnlineHosts = options.maxOnlineHosts;
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listHosts(accountId: string): Promise<RelayHost[]> {
    const result = await this.pool.query(
      "SELECT h.*, EXISTS(SELECT 1 FROM relay_connections c WHERE c.host_id=h.host_id AND c.last_seen > now() - interval '45 seconds') AS online FROM relay_hosts h WHERE account_id=$1 AND NOT revoked ORDER BY created_at",
      [accountId]
    );
    return hostRowSchema.array().parse(result.rows);
  }

  async findHost(hostId: string): Promise<RelayHost | null> {
    const result = await this.pool.query(
      "SELECT * FROM relay_hosts WHERE host_id=$1",
      [hostId]
    );
    return result.rows[0] ? hostRowSchema.parse(result.rows[0]) : null;
  }

  async reserveHost(
    client: PoolClient,
    input: {
      accountId: string;
      hostId: string;
      label: string;
      publicKey: HostPublicKey;
    }
  ): Promise<string> {
    // Serialize quota decisions across all processes, not only this JS instance.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [input.accountId]
    );
    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM relay_hosts WHERE account_id=$1 AND NOT revoked",
      [input.accountId]
    );
    if ((count.rows[0]?.count ?? 0) >= this.#maxHostsPerAccount) {
      throw new RelayRegistryError("host_limit");
    }
    const hostname = `h-${input.hostId.replaceAll("-", "")}.${this.#hostsDomain}`;
    const inserted = await client.query(
      "INSERT INTO relay_hosts(host_id,account_id,label,public_key,hostname) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING host_id",
      [
        input.hostId,
        input.accountId,
        input.label,
        JSON.stringify(hostPublicKeySchema.parse(input.publicKey)),
        hostname,
      ]
    );
    if (inserted.rowCount !== 1) {
      throw new RelayRegistryError("host_conflict");
    }
    return hostname;
  }

  async attachClient(
    client: PoolClient,
    hostId: string,
    clientId: string
  ): Promise<void> {
    const result = await client.query(
      "UPDATE relay_hosts SET client_id=$2 WHERE host_id=$1 AND client_id IS NULL AND NOT revoked",
      [hostId, clientId]
    );
    if (result.rowCount !== 1) {
      throw new RelayRegistryError("host_conflict");
    }
  }

  async revokeHost(accountId: string, hostId: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE relay_hosts SET revoked=TRUE WHERE host_id=$1 AND account_id=$2 RETURNING host_id",
        [hostId, accountId]
      );
      if (result.rowCount !== 1) {
        throw new RelayRegistryError("host_not_found");
      }
      await client.query("DELETE FROM relay_connections WHERE host_id=$1", [
        hostId,
      ]);
    });
  }

  async admit(hostId: string, runId: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(17475, 1)");
      await client.query(
        "DELETE FROM relay_connections WHERE last_seen < now() - interval '45 seconds'"
      );
      const host = await client.query(
        "SELECT host_id FROM relay_hosts WHERE host_id=$1 AND NOT revoked AND client_id IS NOT NULL FOR UPDATE",
        [hostId]
      );
      if (host.rowCount !== 1) {
        throw new RelayRegistryError("host_not_found");
      }
      const prior = await client.query(
        "SELECT 1 FROM relay_connections WHERE host_id=$1",
        [hostId]
      );
      if (prior.rowCount) {
        throw new RelayRegistryError("host_conflict");
      }
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM relay_connections"
      );
      if ((count.rows[0]?.count ?? 0) >= this.#maxOnlineHosts) {
        throw new RelayRegistryError("capacity");
      }
      await client.query(
        "INSERT INTO relay_connections(host_id,run_id) VALUES ($1,$2)",
        [hostId, runId]
      );
    });
  }

  async connection(runId: string, touch = false): Promise<TunnelHost | null> {
    // A revoked registration invalidates an existing signed JWT immediately.
    const result = await this.pool.query(
      `SELECT h.* FROM relay_connections c JOIN relay_hosts h USING(host_id)
      WHERE c.run_id=$1 AND NOT h.revoked AND c.last_seen > now() - interval '45 seconds'`,
      [runId]
    );
    const raw = result.rows[0];
    if (!raw) {
      return null;
    }
    const host = hostRowSchema.parse(raw);
    if (!host.client_id) {
      return null;
    }
    if (touch) {
      await this.pool.query(
        "UPDATE relay_connections SET last_seen=now() WHERE run_id=$1",
        [runId]
      );
    }
    return {
      hostId: host.host_id,
      hostname: host.hostname,
      clientId: host.client_id,
      revoked: host.revoked,
    };
  }
}
