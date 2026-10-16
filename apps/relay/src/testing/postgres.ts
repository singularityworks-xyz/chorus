import { createHmac, generateKeyPairSync } from "node:crypto";
import { hostPublicKeySchema } from "@chorus/contracts";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import { createRelayAuth } from "../auth";
import { RelayEnrollment } from "../enrollment";
import { RELAY_SCHEMA, RelayRegistry } from "../registry";
import { testConfig } from "./config";

/** Opt-in, loopback-only fixture; each run owns one random schema, never public tables. */
export async function createPostgresFixture(connectionString: string) {
  const url = new URL(connectionString);
  if (
    !(
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) ||
    url.pathname !== "/chorus_relay_test" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "PostgreSQL tests require a loopback chorus_relay_test database"
    );
  }
  const schema = `chorus_relay_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const options = {
    connectionString,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
    max: 8,
  };
  const authPool = new Pool(options);
  const registryPool = new Pool(options);
  const config = {
    ...testConfig(),
    databaseUrl: connectionString,
    maxOnlineHosts: 2,
  };
  const relay = createRelayAuth(authPool, config);
  const registry = new RelayRegistry(registryPool, config);
  const publicKey = hostPublicKeySchema.parse(
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
      format: "jwk",
    })
  );
  let schemaCreated = false;

  async function close() {
    const results = await Promise.allSettled([
      authPool.end(),
      registryPool.end(),
    ]);
    try {
      if (schemaCreated) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await admin.end();
    }
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("PostgreSQL fixture pools failed to close");
    }
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await (await getMigrations(relay.auth.options)).runMigrations();
    await registryPool.query(RELAY_SCHEMA);
  } catch (error) {
    await close();
    throw error;
  }
  async function owner() {
    const context = await relay.auth.$context;
    const user = await context.internalAdapter.createUser(
      {
        name: "Owner",
        email: `${crypto.randomUUID()}@example.invalid`,
        emailVerified: true,
      },
      { method: "oauth", oauth: { providerId: "github" } }
    );
    const session = await context.internalAdapter.createSession(user.id, false);
    const signature = createHmac("sha256", config.authSecret)
      .update(session.token)
      .digest("base64");
    const headers = new Headers({
      cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
      origin: config.accountOrigin,
    });
    return { id: user.id, headers };
  }
  async function reserve(accountId: string, hostId = crypto.randomUUID()) {
    await registry.transaction(async (client) => {
      await registry.reserveHost(client, {
        accountId,
        hostId,
        label: "Fixture host",
        publicKey,
      });
      await registry.attachClient(
        client,
        hostId,
        `fixture-${crypto.randomUUID()}`
      );
    });
    return hostId;
  }
  return {
    registry,
    relay,
    enrollment: new RelayEnrollment(registry, relay, config),
    config,
    publicKey,
    owner,
    reserve,
    close,
  };
}
