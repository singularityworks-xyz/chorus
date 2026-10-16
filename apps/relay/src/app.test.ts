import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import { createRelayApp } from "./app";
import { createRelayAuth, INTERNAL_AUTH_HEADER } from "./auth";
import { RelayEnrollment } from "./enrollment";
import { RelayRegistry } from "./registry";
import { testConfig } from "./testing/config";
import { createFrpPlugin, createTunnelVerifier } from "./tunnel/plugin";

describe("relay HTTP authorization", () => {
  test("rejects unauthenticated management, cross-origin commands, and internal headers before storage access", async () => {
    const config = testConfig();
    const database = new Database(":memory:");
    const auth = createRelayAuth(database, config);
    // Registry storage is real but deliberately unreachable. None of these
    // unauthorized requests may reach PostgreSQL or enrollment side effects.
    const pool = new Pool({
      host: "127.0.0.1",
      port: 1,
      connectionTimeoutMillis: 100,
    });
    const registry = new RelayRegistry(pool, config);
    const enrollment = new RelayEnrollment(registry, auth, config);
    try {
      await (await getMigrations(auth.auth.options)).runMigrations();
      const app = createRelayApp({ auth, registry, enrollment, config });
      const id = crypto.randomUUID();
      for (const [method, path] of [
        ["GET", "/v1/hosts"],
        ["GET", `/v1/enrollments/${id}`],
        ["POST", `/v1/enrollments/${id}/approve`],
        ["DELETE", `/v1/hosts/${id}`],
      ]) {
        const response = await app.handle(
          new Request(`${config.accountOrigin}${path}`, {
            method,
            headers: { origin: config.accountOrigin },
          })
        );
        expect(response.status).toBe(401);
      }
      const hostile = await app.handle(
        new Request(`${config.accountOrigin}/v1/hosts/${id}`, {
          method: "DELETE",
          headers: { origin: "https://attacker.example" },
        })
      );
      expect(hostile.status).toBe(403);
      const internal = await app.handle(
        new Request(`${config.accountOrigin}/api/auth/get-session`, {
          headers: { [INTERNAL_AUTH_HEADER]: "injected" },
        })
      );
      expect(internal.status).toBe(400);
      const portal = await app.handle(new Request(config.accountOrigin));
      expect(portal.status).toBe(200);
      expect(portal.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'"
      );
      expect(await portal.text()).toContain("Your work runs on your machines");
    } finally {
      database.close();
      await pool.end();
    }
  });

  test("tunnel plugin rejects malformed credentials and frames without opening routes", async () => {
    const config = testConfig();
    const pool = new Pool({
      host: "127.0.0.1",
      port: 1,
      connectionTimeoutMillis: 100,
    });
    try {
      const registry = new RelayRegistry(pool, config);
      const app = createFrpPlugin(registry, createTunnelVerifier(config));
      for (const [operation, content] of [
        ["Login", { privilege_key: "invalid-jwt" }],
        ["NewProxy", { proxy_type: "tcp", remote_port: 22 }],
        ["Ping", {}],
      ]) {
        const response = await app.handle(
          new Request(`http://localhost/frp?op=${operation}&version=0.1.0`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content }),
          })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          reject: true,
          reject_reason: "authorization unavailable",
        });
      }
    } finally {
      await pool.end();
    }
  });
});
