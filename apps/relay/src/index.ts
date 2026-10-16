import { Pool } from "pg";
import { createRelayApp } from "./app";
import { createRelayAuth } from "./auth";
import { loadRelayConfig } from "./config";
import { RelayEnrollment } from "./enrollment";
import { RelayRegistry } from "./registry";
import { createFrpPlugin, createTunnelVerifier } from "./tunnel/plugin";

const config = loadRelayConfig();
// Separate pools: enrollment holds a registry transaction while creating an
// OAuth client. Sharing an exhausted pool would deadlock those operations.
const poolOptions = {
  connectionString: config.databaseUrl,
  max: 8,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 5000,
  query_timeout: 6000,
};
const authPool = new Pool(poolOptions);
const registryPool = new Pool(poolOptions);
const auth = createRelayAuth(authPool, config);
const registry = new RelayRegistry(registryPool, config);
await registryPool.query("SELECT 1 FROM relay_hosts LIMIT 1");
const enrollment = new RelayEnrollment(registry, auth, config);
const app = createRelayApp({ auth, registry, enrollment, config }).listen({
  hostname: "127.0.0.1",
  port: 8081,
});
const plugin = createFrpPlugin(registry, createTunnelVerifier(config)).listen({
  hostname: "127.0.0.1",
  port: 8082,
});

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  await Promise.all([app.stop(), plugin.stop()]);
  await Promise.all([authPool.end(), registryPool.end()]);
  clearTimeout(deadline);
}
process.on("SIGTERM", () => {
  stop().catch(() => process.exit(1));
});
process.on("SIGINT", () => {
  stop().catch(() => process.exit(1));
});
