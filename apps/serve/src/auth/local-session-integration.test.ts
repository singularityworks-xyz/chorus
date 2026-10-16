import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  devicePairingTokenResponseSchema,
  pairedDeviceListSchema,
} from "@chorus/contracts";
import { Elysia } from "elysia";
import { WorkspaceStore } from "../workspace/store";
import { createDeviceManagementRoutes } from "./device-routes";
import { authGuardHandler } from "./guard";
import { DevicePairingTokenStore } from "./pairing";
import { createAuthRoutes } from "./routes";
import { SessionRegistry } from "./session-registry";

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

describe("local access with registered sessions", () => {
  test("opens without a token and revokes a replayed cookie on logout", async () => {
    const root = mkdtempSync(join(tmpdir(), "chorus-local-session-"));
    const store = new WorkspaceStore(root);
    const token = "local-session-test-only-internal-material";
    const sessionRegistry = new SessionRegistry(store.meta, token);
    const revoked: string[] = [];
    const app = new Elysia()
      .resolve(
        { as: "global" },
        authGuardHandler({
          token,
          sessionRegistry,
          ticketOptions: { store: store.meta },
        })
      )
      .use(
        createAuthRoutes({
          token,
          sessionRegistry,
          isProduction: false,
          localOrigins: ["http://localhost:3000"],
          ticketStore: store.meta,
          pairingTokenStore: new DevicePairingTokenStore(),
        })
      )
      .use(
        createDeviceManagementRoutes({
          token,
          registry: sessionRegistry,
          onRevoke: (deviceId) => {
            revoked.push(deviceId);
            return Promise.resolve();
          },
        })
      )
      .get("/workspace", () => ({ available: true }))
      .listen({ hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${app.server?.port}`;
    try {
      const bootstrap = await fetch(`${base}/auth/local-session`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-chorus-local-bootstrap": "1",
        },
      });
      expect(bootstrap.status).toBe(200);
      const cookies = cookieHeader(bootstrap);
      expect(cookies).toContain("chorus_session=v2.");
      expect(cookies).toContain("chorus_device=");
      const workspace = await fetch(`${base}/workspace`, {
        headers: { cookie: cookies },
      });
      expect(workspace.status).toBe(200);
      const pairing = await fetch(`${base}/auth/device-pairing`, {
        method: "POST",
        headers: { cookie: cookies },
      });
      const code = devicePairingTokenResponseSchema.parse(
        await pairing.json()
      ).token;
      const mobile = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: code }),
      });
      expect(mobile.status).toBe(200);
      const mobileCookies = cookieHeader(mobile);
      const listResponse = await fetch(`${base}/auth/devices`, {
        headers: { cookie: mobileCookies },
      });
      const devices = pairedDeviceListSchema.parse(await listResponse.json());
      expect(devices.devices).toHaveLength(2);
      const revoke = await fetch(
        `${base}/auth/devices/${devices.currentDeviceId}`,
        { method: "DELETE", headers: { cookie: cookies } }
      );
      expect(revoke.status).toBe(200);
      expect(revoked).toEqual([devices.currentDeviceId]);
      expect(
        (
          await fetch(`${base}/workspace`, {
            headers: { cookie: mobileCookies },
          })
        ).status
      ).toBe(401);
      expect(
        (await fetch(`${base}/workspace`, { headers: { cookie: cookies } }))
          .status
      ).toBe(200);
      const logout = await fetch(`${base}/auth/logout`, {
        method: "POST",
        headers: { cookie: cookies },
      });
      expect(logout.status).toBe(200);
      const replay = await fetch(`${base}/workspace`, {
        headers: { cookie: cookies },
      });
      expect(replay.status).toBe(401);
      const fresh = await fetch(`${base}/auth/local-session`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-chorus-local-bootstrap": "1",
          cookie: cookies,
        },
      });
      expect(fresh.status).toBe(200);
      expect(cookieHeader(fresh)).not.toBe(cookies);
      // Production's device cap is an explicit conflict, not a server error.
      for (let index = 0; index < 9; index++) {
        const added = await fetch(`${base}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        expect(added.status).toBe(200);
      }
      const full = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(full.status).toBe(409);
      expect(await full.json()).toMatchObject({ code: "device_limit_reached" });
    } finally {
      await app.stop(true);
      await store.close();
      if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
