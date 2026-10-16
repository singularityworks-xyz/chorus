import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import { createRelayAuth } from "./auth";
import { loadRelayConfig } from "./config";
import { RELAY_SCHEMA } from "./registry";

// Explicit operator operation; normal startup never silently migrates schemas.
const config = loadRelayConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
try {
  const { auth } = createRelayAuth(pool, config);
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(RELAY_SCHEMA);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
