import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { RelayRegistry, RelayRegistryError } from "./registry";
import { createPostgresFixture } from "./testing/postgres";

const databaseUrl = process.env.CHORUS_TEST_POSTGRES_URL;
// Normal unit runs must never discover/use an operator database automatically.
describe.skipIf(!databaseUrl)("relay real PostgreSQL integration", () => {
  let fixture: Awaited<ReturnType<typeof createPostgresFixture>> | undefined;
  function database() {
    if (!fixture) {
      throw new Error("PostgreSQL fixture is unavailable");
    }
    return fixture;
  }
  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("PostgreSQL test connection is required");
    }
    fixture = await createPostgresFixture(databaseUrl);
  }, 30_000);
  beforeEach(async () => {
    await database().registry.pool.query(
      "TRUNCATE relay_connections, relay_hosts, relay_enrollments"
    );
  });
  afterAll(async () => {
    await fixture?.close();
  });

  test("serializes concurrent per-account reservations without oversubscribing", async () => {
    const { registry, owner, publicKey } = database();
    const account = await owner();
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, () =>
        registry.transaction((client) =>
          registry.reserveHost(client, {
            accountId: account.id,
            hostId: crypto.randomUUID(),
            label: "Laptop",
            publicKey,
          })
        )
      )
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(3);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(RelayRegistryError);
        expect(result.reason.code).toBe("host_limit");
      }
    }
    expect(await registry.listHosts(account.id)).toHaveLength(3);
    const independent = await owner();
    await database().reserve(independent.id);
    expect(await registry.listHosts(independent.id)).toHaveLength(1);
  }, 20_000);

  test("admits exactly 100 concurrent online hosts at the production registry limit", async () => {
    const { registry: fixtureRegistry, reserve, owner, config } = database();
    const registry = new RelayRegistry(fixtureRegistry.pool, {
      ...config,
      maxOnlineHosts: 100,
    });
    const accounts: Awaited<ReturnType<typeof owner>>[] = [];
    for (let index = 0; index < 35; index++) {
      accounts.push(await owner());
    }
    const hosts = await Promise.all(
      accounts.flatMap((account) =>
        Array.from({ length: 3 }, () => reserve(account.id))
      )
    );
    const results = await Promise.allSettled(
      hosts.map((host) => registry.admit(host, crypto.randomUUID()))
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(100);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(5);
    for (const result of failures) {
      expect(result.reason.code).toBe("capacity");
    }
    const count = await registry.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM relay_connections"
    );
    expect(count.rows[0]?.count).toBe(100);
  }, 30_000);

  test("a host identity cannot be registered to two accounts concurrently", async () => {
    const { registry, owner, publicKey } = database();
    const owners = [await owner(), await owner()];
    const hostId = crypto.randomUUID();
    const results = await Promise.allSettled(
      owners.map((account) =>
        registry.transaction((client) =>
          registry.reserveHost(client, {
            accountId: account.id,
            hostId,
            label: "Host",
            publicKey,
          })
        )
      )
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason.code).toBe("host_conflict");
  });

  test("enforces global online capacity and invalidates revoked/expired connections", async () => {
    const { registry, reserve, owner } = database();
    const first = await owner();
    const second = await owner();
    const hosts = await Promise.all([
      reserve(first.id),
      reserve(first.id),
      reserve(first.id),
      reserve(second.id),
      reserve(second.id),
      reserve(second.id),
    ]);
    const runs = hosts.map(() => crypto.randomUUID());
    const results = await Promise.allSettled(
      hosts.map((id, index) => registry.admit(id, runs[index] ?? ""))
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(2);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason.code).toBe("capacity");
      }
    }
    const active = results.findIndex((result) => result.status === "fulfilled");
    const host = hosts[active];
    const run = runs[active];
    if (!(host && run)) {
      throw new Error("no admitted host");
    }
    expect(await registry.connection(run, true)).not.toBeNull();
    await expect(registry.admit(host, crypto.randomUUID())).rejects.toThrow(
      "host_conflict"
    );
    const registration = await registry.findHost(host);
    if (!registration) {
      throw new Error("registration missing");
    }
    const stranger = registration.account_id === first.id ? second : first;
    await expect(registry.revokeHost(stranger.id, host)).rejects.toThrow(
      "host_not_found"
    );
    expect(await registry.connection(run)).not.toBeNull();
    await registry.revokeHost(registration.account_id, host);
    expect(await registry.connection(run)).toBeNull();
    await expect(registry.admit(host, crypto.randomUUID())).rejects.toThrow(
      "host_not_found"
    );
    await registry.pool.query(
      "UPDATE relay_connections SET last_seen=now() - interval '46 seconds'"
    );
    const next = hosts.find((id) => id !== host);
    if (!next) {
      throw new Error("fixture host missing");
    }
    const nextRun = crypto.randomUUID();
    await registry.admit(next, nextRun);
    expect(await registry.connection(nextRun)).not.toBeNull();
  }, 20_000);

  test("rolls back reservation failures and releases the pooled transaction", async () => {
    const { registry, owner, publicKey, reserve } = database();
    const account = await owner();
    const hostId = crypto.randomUUID();
    await expect(
      registry.transaction(async (client) => {
        await registry.reserveHost(client, {
          accountId: account.id,
          hostId,
          label: "Host",
          publicKey,
        });
        throw new Error("fixture rollback");
      })
    ).rejects.toThrow("fixture rollback");
    expect(await registry.findHost(hostId)).toBeNull();
    expect(await registry.listHosts(account.id)).toHaveLength(0);
    await reserve(account.id, hostId);
    expect(await registry.findHost(hostId)).not.toBeNull();
    expect(registry.pool.waitingCount).toBe(0);
  });

  test("failed unauthenticated enrollment approval rolls back and remains retryable", async () => {
    const { registry, enrollment, publicKey, owner } = database();
    const request = await enrollment.begin({
      hostId: crypto.randomUUID(),
      label: "Laptop",
      publicKey,
    });
    const account = await owner();
    await expect(
      enrollment.approve(request.enrollmentId, account.id, new Headers())
    ).rejects.toThrow();
    expect(await registry.listHosts(account.id)).toHaveLength(0);
    expect((await enrollment.describe(request.enrollmentId)).status).toBe(
      "pending"
    );
    await enrollment.approve(request.enrollmentId, account.id, account.headers);
    expect(await registry.listHosts(account.id)).toHaveLength(1);
  }, 20_000);

  test("delivers a real PostgreSQL-backed machine grant once and rejects replay after revocation", async () => {
    const { registry, relay, enrollment, publicKey, owner, config } =
      database();
    const account = await owner();
    const hostId = crypto.randomUUID();
    const request = await enrollment.begin({
      hostId,
      label: "Laptop",
      publicKey,
    });
    const poll = {
      enrollmentId: request.enrollmentId,
      pollSecret: request.pollSecret,
    };
    expect(await enrollment.poll(poll)).toEqual({ status: "pending" });
    await expect(
      enrollment.poll({ ...poll, pollSecret: "0".repeat(64) })
    ).rejects.toThrow("invalid_enrollment");
    await enrollment.approve(request.enrollmentId, account.id, account.headers);
    const approved = await enrollment.poll(poll);
    if (approved.status !== "approved") {
      throw new Error("enrollment not approved");
    }
    const envelope = await registry.pool.query<{ credential_envelope: string }>(
      "SELECT credential_envelope FROM relay_enrollments WHERE enrollment_id=$1",
      [request.enrollmentId]
    );
    expect(envelope.rows[0]?.credential_envelope).not.toContain(
      approved.connection.clientSecret
    );
    const tokenRequest = () =>
      relay.auth.handler(
        new Request(`${config.issuer}/oauth2/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`${approved.connection.clientId}:${approved.connection.clientSecret}`).toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            scope: "relay:connect",
            resource: config.tunnelAudience,
            audience: config.tunnelAudience,
          }),
        })
      );
    const response = await tokenRequest();
    expect(response.status).toBe(200);
    const token = z
      .object({ access_token: z.string(), expires_in: z.number().max(300) })
      .parse(await response.json());
    const keyResponse = await relay.auth.handler(
      new Request(`${config.issuer}/jwks`)
    );
    const keys = z
      .object({ keys: z.array(z.record(z.string(), z.unknown())) })
      .parse(await keyResponse.json());
    const verified = await jwtVerify(
      token.access_token,
      createLocalJWKSet(keys),
      {
        issuer: config.issuer,
        audience: config.tunnelAudience,
        algorithms: ["RS256"],
        typ: "at+jwt",
      }
    );
    expect(verified.payload.host_id).toBe(hostId);
    expect(verified.payload.token_kind).toBe("relay_host");
    expect(await enrollment.poll(poll, true)).toEqual({ status: "complete" });
    expect(await enrollment.poll(poll)).toEqual({ status: "complete" });
    const delivered = await registry.pool.query<{
      credential_envelope: string | null;
    }>(
      "SELECT credential_envelope FROM relay_enrollments WHERE enrollment_id=$1",
      [request.enrollmentId]
    );
    expect(delivered.rows[0]?.credential_envelope).toBeNull();
    const run = crypto.randomUUID();
    await registry.admit(hostId, run);
    await registry.revokeHost(account.id, hostId);
    expect(await registry.connection(run)).toBeNull();
    await relay.disableMachineClient(
      account.headers,
      approved.connection.clientId
    );
    expect((await tokenRequest()).status).toBeGreaterThanOrEqual(400);
  }, 20_000);

  test("serializes duplicate approvals and rejects expired pending challenges", async () => {
    const { registry, enrollment, publicKey, owner } = database();
    const account = await owner();
    const request = await enrollment.begin({
      hostId: crypto.randomUUID(),
      label: "Laptop",
      publicKey,
    });
    const results = await Promise.allSettled([
      enrollment.approve(request.enrollmentId, account.id, account.headers),
      enrollment.approve(request.enrollmentId, account.id, account.headers),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(await registry.listHosts(account.id)).toHaveLength(1);
    const pending = await enrollment.begin({
      hostId: crypto.randomUUID(),
      label: "Other host",
      publicKey,
    });
    await registry.pool.query(
      "UPDATE relay_enrollments SET expires_at=now() - interval '1 second' WHERE enrollment_id=$1",
      [pending.enrollmentId]
    );
    await expect(enrollment.describe(pending.enrollmentId)).rejects.toThrow(
      "invalid_enrollment"
    );
    await expect(
      enrollment.poll({
        enrollmentId: pending.enrollmentId,
        pollSecret: pending.pollSecret,
      })
    ).rejects.toThrow("invalid_enrollment");
    await enrollment.begin({
      hostId: crypto.randomUUID(),
      label: "Fresh",
      publicKey,
    });
    const removed = await registry.pool.query(
      "SELECT 1 FROM relay_enrollments WHERE enrollment_id=$1",
      [pending.enrollmentId]
    );
    expect(removed.rowCount).toBe(0);
  }, 20_000);
});
