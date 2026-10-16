import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { createRelayAuth } from "./auth";
import { testConfig } from "./testing/config";

describe("relay account authentication", () => {
  test("an approved account creates a scoped machine grant with verifiable host claims", async () => {
    const database = new Database(":memory:");
    const config = testConfig();
    const relay = createRelayAuth(database, config);
    try {
      await (await getMigrations(relay.auth.options)).runMigrations();
      const context = await relay.auth.$context;
      // Account fixtures cross the real database adapter; all session, admin,
      // token issuance, JWKS, and signature validation paths remain real.
      const user = await context.internalAdapter.createUser(
        {
          name: "Owner",
          email: "owner@example.com",
          emailVerified: true,
        },
        { method: "oauth", oauth: { providerId: "github" } }
      );
      const session = await context.internalAdapter.createSession(
        user.id,
        false
      );
      const signature = createHmac("sha256", config.authSecret)
        .update(session.token)
        .digest("base64");
      const headers = new Headers({
        cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
        origin: config.accountOrigin,
      });
      expect((await relay.auth.api.getSession({ headers }))?.user.id).toBe(
        user.id
      );
      const hostId = crypto.randomUUID();
      await expect(
        relay.auth.api.adminCreateOAuthClient({
          headers,
          body: {
            client_name: "Unprivileged browser",
            grant_types: ["client_credentials"],
            client_credentials_scopes: ["relay:connect"],
          },
        })
      ).rejects.toThrow();
      const client = await relay.createMachineClient(headers, hostId);
      const tokenRequest = () =>
        relay.auth.handler(
          new Request(`${config.issuer}/oauth2/token`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`,
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
        .object({
          access_token: z.string().min(1),
          expires_in: z.number().max(300),
        })
        .parse(await response.json());
      const keys = await relay.auth.handler(
        new Request(`${config.issuer}/jwks`)
      );
      const keySet = z
        .object({ keys: z.array(z.record(z.string(), z.unknown())) })
        .parse(await keys.json());
      const verified = await jwtVerify(
        token.access_token,
        createLocalJWKSet(keySet),
        {
          issuer: config.issuer,
          audience: config.tunnelAudience,
          algorithms: ["RS256"],
          typ: "at+jwt",
        }
      );
      expect(verified.payload).toMatchObject({
        host_id: hostId,
        token_kind: "relay_host",
        client_id: client.client_id,
        scope: "relay:connect",
      });
      await relay.disableMachineClient(headers, client.client_id);
      expect((await tokenRequest()).status).toBeGreaterThanOrEqual(400);
    } finally {
      database.close();
    }
  });

  test("migrates its schema, uses host-only secure cookies, and denies unowned machine clients", async () => {
    const database = new Database(":memory:");
    const config = testConfig();
    const { auth, createMachineClient } = createRelayAuth(database, config);
    try {
      const migrations = await getMigrations(auth.options);
      await migrations.runMigrations();
      const context = await auth.$context;
      const cookie = context.authCookies.sessionToken;
      expect(cookie.name.startsWith("__Host-")).toBe(true);
      expect(cookie.attributes.secure).toBe(true);
      expect(cookie.attributes.httpOnly).toBe(true);
      expect(cookie.attributes.path).toBe("/");
      expect(cookie.attributes.domain).toBeUndefined();
      const session = await auth.api.getSession({ headers: new Headers() });
      expect(session).toBeNull();
      await expect(
        createMachineClient(new Headers(), crypto.randomUUID())
      ).rejects.toThrow();
      const response = await auth.handler(
        new Request(`${config.issuer}/oauth2/register`, {
          method: "POST",
          headers: {
            origin: config.accountOrigin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            grant_types: ["client_credentials"],
            client_credentials_scopes: ["relay:connect"],
          }),
        })
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      database.close();
    }
  });
});
