import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Elysia } from "elysia";
import { WorkspaceStore } from "../workspace/store";
import { authGuardHandler } from "./guard";
import { createLocalEntry, localEntryRequestAllowed } from "./local-entry";
import { DevicePairingTokenStore } from "./pairing";
import { createAuthRoutes } from "./routes";
import { SessionRegistry } from "./session-registry";

describe("installed production local entry", () => {
  test("accepts only an exact loopback page and a direct loopback peer", () => {
    const request = (
      origin: string,
      url = "http://localhost:2001/auth/local-session"
    ) => new Request(url, { headers: { origin } });
    expect(
      localEntryRequestAllowed(
        request("http://localhost:3000"),
        "127.0.0.1",
        3000
      )
    ).toBe(true);
    for (const origin of [
      "https://remote.example",
      "http://localhost:3001",
      "http://localhost:3000/",
      "http://user@localhost:3000",
      "http://localhost.attacker.test:3000",
    ]) {
      expect(localEntryRequestAllowed(request(origin), "127.0.0.1", 3000)).toBe(
        false
      );
    }
    expect(
      localEntryRequestAllowed(
        request("http://localhost:3000"),
        "192.168.0.4",
        3000
      )
    ).toBe(false);
    expect(
      localEntryRequestAllowed(
        request(
          "http://localhost:3000",
          "http://remote.example/auth/local-session"
        ),
        "127.0.0.1",
        3000
      )
    ).toBe(false);
  });

  test("creates a protected revocable cookie only on the private listener; production ingress refuses bootstrap", async () => {
    const root = await mkdtemp(join(tmpdir(), "chorus-production-entry-"));
    const store = new WorkspaceStore(root);
    const token = "production-entry-test-signing-material";
    const registry = new SessionRegistry(store.meta, token);
    const local = createLocalEntry({ token, registry }).listen({
      hostname: "127.0.0.1",
      port: 0,
    });
    const main = new Elysia()
      .resolve(
        { as: "global" },
        authGuardHandler({
          token,
          sessionRegistry: registry,
          ticketOptions: { store: store.meta },
        })
      )
      .use(
        createAuthRoutes({
          token,
          sessionRegistry: registry,
          isProduction: true,
          localOrigins: [],
          ticketStore: store.meta,
          pairingTokenStore: new DevicePairingTokenStore(),
        })
      )
      .get("/workspace", () => ({ available: true }))
      .listen({ hostname: "127.0.0.1", port: 0 });
    const localBase = `http://127.0.0.1:${local.server?.port}`;
    const mainBase = `http://127.0.0.1:${main.server?.port}`;
    const headers = {
      origin: "http://127.0.0.1:3000",
      "x-chorus-local-bootstrap": "1",
    };
    try {
      const preflight = await fetch(`${localBase}/auth/local-session`, {
        method: "OPTIONS",
        headers: {
          origin: headers.origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-chorus-local-bootstrap",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        headers.origin
      );
      expect(preflight.headers.getSetCookie()).toHaveLength(0);
      expect(
        (
          await fetch(`${mainBase}/auth/local-session`, {
            method: "POST",
            headers,
          })
        ).status
      ).toBe(403);
      const remote = await fetch(`${localBase}/auth/local-session`, {
        method: "POST",
        headers: {
          ...headers,
          origin: "https://host.example",
          "x-forwarded-for": "127.0.0.1",
        },
      });
      expect(remote.status).toBe(403);
      expect(remote.headers.get("access-control-allow-origin")).toBeNull();
      const response = await fetch(`${localBase}/auth/local-session`, {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(200);
      const issued = response.headers.getSetCookie();
      expect(issued).toHaveLength(2);
      expect(
        issued.every(
          (cookie) =>
            cookie.startsWith("__Host-") &&
            cookie.includes("Secure") &&
            cookie.includes("HttpOnly") &&
            !cookie.includes("Domain=")
        )
      ).toBe(true);
      const cookie = issued.map((value) => value.split(";")[0]).join("; ");
      expect(
        (await fetch(`${mainBase}/workspace`, { headers: { cookie } })).status
      ).toBe(200);
      const again = await fetch(`${localBase}/auth/local-session`, {
        method: "POST",
        headers: { ...headers, cookie },
      });
      expect(again.status).toBe(200);
      expect(again.headers.getSetCookie()).toHaveLength(0);
      expect(registry.list()).toHaveLength(1);
      const device = registry.list()[0];
      if (!device) {
        throw new Error("local entry did not register its device");
      }
      registry.revokeDevice(device.deviceId);
      expect(
        (await fetch(`${mainBase}/workspace`, { headers: { cookie } })).status
      ).toBe(401);
    } finally {
      await local.stop(true);
      await main.stop(true);
      await store.close();
      if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
