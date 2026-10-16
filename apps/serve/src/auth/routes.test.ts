import { describe, expect, test } from "bun:test";
import { devicePairingTokenResponseSchema } from "@chorus/contracts";
import { LoginRateLimiter } from "./brute-force";
import { DevicePairingTokenStore } from "./pairing";
import { createAuthRoutes } from "./routes";
import {
  issueSessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./session";
import type { TicketStore } from "./ticket";

const INSTANCE_TOKEN = "f".repeat(64);

function makeTicketStore(): TicketStore {
  const rows = new Map<string, string>();
  return {
    deleteMeta: (key) => {
      rows.delete(key);
    },
    entriesWithPrefix: (prefix) =>
      [...rows].filter(([key]) => key.startsWith(prefix)),
    getMeta: (key) => rows.get(key) ?? null,
    setMeta: (key, value) => {
      rows.set(key, value);
    },
  };
}

function makeRoutes() {
  return createAuthRoutes({
    isProduction: false,
    localOrigins: ["http://localhost:3000"],
    pairingTokenStore: new DevicePairingTokenStore(),
    rateLimiter: new LoginRateLimiter(),
    ticketStore: makeTicketStore(),
    token: INSTANCE_TOKEN,
  });
}

async function authenticatedCookie(): Promise<string> {
  const session = await issueSessionCookie(
    { token: INSTANCE_TOKEN },
    SESSION_TTL_SECONDS
  );
  return `${SESSION_COOKIE}=${session.cookie}`;
}

describe("authentication routes", () => {
  test("an authenticated device can issue a one-time pairing code", async () => {
    const routes = makeRoutes();
    const response = await routes.handle(
      new Request("http://localhost/auth/device-pairing", {
        headers: { cookie: await authenticatedCookie() },
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    const parsed = devicePairingTokenResponseSchema.safeParse(
      await response.json()
    );
    expect(parsed.success).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a pairing code creates a session once and is rejected on replay", async () => {
    const routes = makeRoutes();
    const issueResponse = await routes.handle(
      new Request("http://localhost/auth/device-pairing", {
        headers: { cookie: await authenticatedCookie() },
        method: "POST",
      })
    );
    const issued = devicePairingTokenResponseSchema.parse(
      await issueResponse.json()
    );
    const loginRequest = () =>
      routes.handle(
        new Request("http://localhost/auth/login", {
          body: JSON.stringify({ token: issued.token }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      );

    const firstLogin = await loginRequest();
    expect(firstLogin.status).toBe(200);
    expect(firstLogin.headers.get("set-cookie")).toContain(
      `${SESSION_COOKIE}=`
    );
    expect((await loginRequest()).status).toBe(401);
  });

  test("pairing code generation requires a valid session", async () => {
    const response = await makeRoutes().handle(
      new Request("http://localhost/auth/device-pairing", {
        method: "POST",
      })
    );

    expect(response.status).toBe(401);
  });

  test("local bootstrap fails closed without a real loopback peer", async () => {
    const response = await makeRoutes().handle(
      new Request("http://localhost/auth/local-session", {
        headers: {
          origin: "http://localhost:3000",
          "x-chorus-local-bootstrap": "1",
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
