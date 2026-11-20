import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_SECURITY_POLICY } from "../security-headers";

const SERVE_ENTRY = join(import.meta.dir, "..", "index.ts");

const HEX_32 = /^[0-9a-f]{32}$/;
const COOKIE_PAIR = /(?:__Host-)?chorus_session=[^;]+/;
const DEVICE_COOKIE_PAIR = /(?:__Host-)?chorus_device=[^;]+/;
const COOKIE_VALUE = /(?:__Host-)?chorus_session=([^;]+)/;

const MODE_MASK = 0o777;

const TOKEN = "f".repeat(64);

const GATED_ROUTES = [
  { label: "GET /auth/devices", method: "GET", path: "/auth/devices" },
  { label: "GET /hosting/remote", method: "GET", path: "/hosting/remote" },
  {
    label: "POST /hosting/remote/enrollment",
    method: "POST",
    path: "/hosting/remote/enrollment",
    body: { label: "Laptop" },
  },
  {
    label: "POST /hosting/remote/connection",
    method: "POST",
    path: "/hosting/remote/connection",
    body: { enabled: true },
  },
  { label: "GET /models", method: "GET", path: "/models" },
  { label: "GET /providers", method: "GET", path: "/providers" },
  {
    label: "GET /opencode/auth-credentials",
    method: "GET",
    path: "/opencode/auth-credentials",
  },
  {
    label: "GET /opencode/configured-providers",
    method: "GET",
    path: "/opencode/configured-providers",
  },
  { label: "GET /auth/push-config", method: "GET", path: "/auth/push-config" },
  {
    label: "POST /auth/push-subscriptions",
    method: "POST",
    path: "/auth/push-subscriptions",
    body: {},
  },
  {
    label: "DELETE /auth/push-subscriptions",
    method: "DELETE",
    path: "/auth/push-subscriptions",
    body: {},
  },
  { label: "GET /workspace", method: "GET", path: "/workspace" },
  {
    label: "POST /tasks",
    method: "POST",
    path: "/tasks",
    body: {},
  },
  { label: "GET /projects", method: "GET", path: "/projects" },
  { label: "GET /voice/voices", method: "GET", path: "/voice/voices" },
  {
    label: "GET /snapshots/diff",
    method: "GET",
    path: "/snapshots/diff?directory=%2Fetc&fromHash=HEAD",
  },
  {
    label: "GET /git/status",
    method: "GET",
    path: "/git/status?directory=%2Fetc",
  },
  { label: "GET /bridge/status", method: "GET", path: "/bridge/status" },
  {
    label: "GET /sessions/:sessionID/diff",
    method: "GET",
    path: "/sessions/session-1/diff",
  },
  { label: "GET /auth/ws-ticket", method: "GET", path: "/auth/ws-ticket" },
  { label: "POST /auth/device", method: "POST", path: "/auth/device" },
  {
    label: "POST /auth/device-pairing",
    method: "POST",
    path: "/auth/device-pairing",
    body: {},
  },
];

interface ServerHandle {
  base: string;
  cookie: string;
  dataDir: string;
  port: number;
  stop: () => Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), "chorus-auth-"));
  const port = 24_000 + Math.floor(Math.random() * 4000);

  const child = Bun.spawn(["bun", "run", SERVE_ENTRY], {
    env: {
      ...process.env,
      CHORUS_TOKEN: TOKEN,
      DATA_DIR: dataDir,
      NODE_ENV: "production",
      OPENCODE_AUTO_START: "false",
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.killed) {
      throw new Error(
        `serve exited during boot: ${await new Response(child.stderr).text()}`
      );
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        const login = await fetch(`${base}/auth/login`, {
          body: JSON.stringify({ token: TOKEN }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const setCookie = login.headers.get("set-cookie") ?? "";
        const sessionCookie = setCookie.match(COOKIE_PAIR)?.[0] ?? "";

        const deviceResponse = sessionCookie
          ? await fetch(`${base}/auth/device`, {
              headers: { cookie: sessionCookie },
              method: "POST",
            })
          : null;
        const deviceCookie =
          deviceResponse?.headers
            .get("set-cookie")
            ?.match(DEVICE_COOKIE_PAIR)?.[0] ?? "";
        const cookie = [sessionCookie, deviceCookie].filter(Boolean).join("; ");

        if (login.status === 200 && deviceResponse?.ok && cookie) {
          return {
            base,
            cookie,
            dataDir,
            port,
            stop: async () => {
              child.kill("SIGTERM");
              await child.exited;
              rmSync(dataDir, { force: true, recursive: true });
            },
          };
        }
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }

  child.kill("SIGKILL");
  throw new Error("serve did not become healthy in time");
}

function authed(server: ServerHandle, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("cookie", server.cookie);
  return { ...init, headers };
}

const server = await startServer();

describe("Phase 4 auth matrix (plan P4 integration tests)", () => {
  test("the server is up and healthy without a credential", async () => {
    const res = await fetch(`${server.base}/health`);

    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({
      status: "ok",
    });
  });

  for (const route of GATED_ROUTES) {
    test(`${route.label} answers 401 without a session`, async () => {
      const res = await fetch(`${server.base}${route.path}`, {
        body: route.body ? JSON.stringify(route.body) : undefined,
        headers: route.body ? { "content-type": "application/json" } : {},
        method: route.method,
      });

      expect(res.status).toBe(401);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: "unauthorized",
      });
    });
  }

  test("a valid login yields a cookie that authenticates", async () => {
    const workspace = await fetch(`${server.base}/workspace`, {
      headers: { cookie: server.cookie },
    });

    expect(workspace.status).toBe(200);
  });

  test("the login screen is reachable without a session", async () => {
    const res = await fetch(`${server.base}/`);

    expect(res.status).not.toBe(401);
  });

  test("the session cookie carries HttpOnly, SameSite=Strict, and a 30-day Max-Age", async () => {
    const login = await fetch(`${server.base}/auth/login`, {
      body: JSON.stringify({ token: TOKEN }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const setCookie = login.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("chorus_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=2592000");

    expect(setCookie).toContain("Secure");
  });

  test("the wrong token is rejected and does not set a cookie", async () => {
    const res = await fetch(`${server.base}/auth/login`, {
      body: JSON.stringify({ token: "not-the-token" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a forged cookie is rejected", async () => {
    for (const cookie of [
      "chorus_session=v1.deadbeef.c2ln",
      "chorus_session=garbage",
      "chorus_session=",
      "chorus_session=v1.zzzzzzzzzz.AAAA",
    ]) {
      const res = await fetch(`${server.base}/workspace`, {
        headers: { cookie },
      });

      expect(res.status).toBe(401);
    }
  });

  test("a tampered opaque session credential is rejected", async () => {
    const login = await fetch(`${server.base}/auth/login`, {
      body: JSON.stringify({ token: TOKEN }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const good = login.headers.get("set-cookie") ?? "";
    const value = good.match(COOKIE_VALUE)?.[1] ?? "";
    expect(value.startsWith("v2.")).toBe(true);
    const last = value.endsWith("0") ? "1" : "0";
    const tampered = `__Host-chorus_session=${value.slice(0, -1)}${last}`;

    const res = await fetch(`${server.base}/workspace`, {
      headers: { cookie: tampered },
    });

    expect(res.status).toBe(401);
  });

  test("logout clears the cookie", async () => {
    const login = await fetch(`${server.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const ownCookie =
      login.headers.get("set-cookie")?.match(COOKIE_PAIR)?.[0] ?? "";
    const res = await fetch(`${server.base}/auth/logout`, {
      headers: { cookie: ownCookie },
      method: "POST",
    });

    const setCookie = res.headers.get("set-cookie") ?? "";

    expect(res.status).toBe(200);
    expect(setCookie).toContain("Max-Age=0");
  });

  test("an unregistered directory is refused even when authenticated", async () => {
    for (const path of [
      "/snapshots/diff?directory=%2Fetc&fromHash=HEAD",
      "/git/status?directory=%2Fetc",
      "/snapshots/diff?directory=%2F&fromHash=HEAD",
    ]) {
      const res = await fetch(`${server.base}${path}`, authed(server));

      expect(res.status).toBe(403);
    }
  });

  test("a traversal attempt against the static root is refused", async () => {
    const res = await fetch(`${server.base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);

    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("root:");
  });

  test("every response carries the Content-Security-Policy", async () => {
    for (const path of ["/", "/health", "/workspace"]) {
      const res = await fetch(`${server.base}${path}`);
      const policy = res.headers.get("content-security-policy");

      expect(policy).toBe(CONTENT_SECURITY_POLICY);
      expect(policy ?? "").not.toContain("unsafe-eval");
    }
  });

  test("chorus.db and chorus.token are written 0600", () => {
    const db = join(server.dataDir, "chorus.db");
    const tokenFile = join(server.dataDir, "chorus.token");

    expect(statSync(db).isFile()).toBe(true);
    if (process.platform !== "win32") {
      // biome-ignore lint/suspicious/noBitwiseOperators: reading POSIX mode bits
      expect(statSync(db).mode & MODE_MASK).toBe(0o600);
    }

    expect(() => statSync(tokenFile)).toThrow();
  });

  test("a shell injection payload in a git revision is inert", async () => {
    const marker = "/tmp/chorus-pwned-marker";

    const res = await fetch(
      `${server.base}/snapshots/diff?directory=%2Ftmp&fromHash=${encodeURIComponent(
        `x; touch ${marker}`
      )}`,
      authed(server)
    );

    expect(res.status).toBe(403);
    expect(() => statSync(marker)).toThrow();
  });

  test("an unauthenticated WebSocket upgrade is closed with 4401", async () => {
    const code = await wsCloseCode(`${server.base}/ws`);

    expect(code).toBe(4401);
  });

  test("a single-use ticket authenticates one upgrade and no more", async () => {
    const ticketRes = await fetch(`${server.base}/auth/ws-ticket`, {
      headers: { cookie: server.cookie },
    });
    expect(ticketRes.status).toBe(200);
    expect(ticketRes.headers.get("cache-control")).toBe("no-store");

    const { ticket } = (await ticketRes.json()) as { ticket: string };
    expect(ticket).toMatch(HEX_32);

    const first = await wsFrames(`${server.base}/ws?ticket=${ticket}`);
    expect(first).toBe("open");

    expect(await wsCloseCode(`${server.base}/ws?ticket=${ticket}`)).toBe(4401);
  });

  test("a WS ticket minted for one device cannot be used with another identity", async () => {
    const ticketRes = await fetch(`${server.base}/auth/ws-ticket`, {
      headers: { cookie: server.cookie },
    });
    expect(ticketRes.status).toBe(200);
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    const otherLogin = await fetch(`${server.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const otherSession =
      otherLogin.headers.get("set-cookie")?.match(COOKIE_PAIR)?.[0] ?? "";
    const otherDevice = await fetch(`${server.base}/auth/device`, {
      headers: { cookie: otherSession },
      method: "POST",
    });
    const otherCookie =
      otherDevice.headers.get("set-cookie")?.match(DEVICE_COOKIE_PAIR)?.[0] ??
      "";
    expect(otherCookie).toBeTruthy();
    expect(
      await wsCloseCode(`${server.base}/ws?ticket=${ticket}`, {
        cookie: `${server.cookie.split(";")[0]}; ${otherCookie}`,
      })
    ).toBe(4401);
  });

  test("a WebSocket ticket cannot be minted without a session", async () => {
    const res = await fetch(`${server.base}/auth/ws-ticket`);

    expect(res.status).toBe(401);
  });

  test("an unknown ticket is refused", async () => {
    expect(
      await wsCloseCode(`${server.base}/ws?ticket=${"0".repeat(32)}`)
    ).toBe(4401);
  });

  test("the cookie also authenticates the WebSocket upgrade", async () => {
    expect(await wsFrames(`${server.base}/ws`, { cookie: server.cookie })).toBe(
      "open"
    );
  });

  test("the brute-force guard trips after ten failed logins", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await fetch(`${server.base}/auth/login`, {
        body: JSON.stringify({ token: `wrong-${attempt}` }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10).every((code) => code === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    const good = await fetch(`${server.base}/auth/login`, {
      body: JSON.stringify({ token: TOKEN }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(good.status).toBe(429);
  });

  test("stopping the server shuts down cleanly", async () => {
    await server.stop();

    await expect(fetch(`${server.base}/health`)).rejects.toBeDefined();
  });
});

// biome-ignore lint/suspicious/useAwait: returns a Promise it awaits internally
async function wsCloseCode(
  url: string,
  headers: Record<string, string> = {}
): Promise<number | "open"> {
  return new Promise<number | "open">((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      socket.close();
      resolve("open");
    }, 2500);

    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    };
  });
}

// biome-ignore lint/suspicious/useAwait: returns the promise it constructs
async function wsFrames(
  url: string,
  headers: Record<string, string> = {}
): Promise<"open" | number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      socket.close();
      resolve("open");
    }, 3000);

    socket.onopen = () => {
      socket.send(JSON.stringify({ since: 0, type: "hello" }));
    };
    socket.onmessage = (event) => {
      clearTimeout(timer);
      try {
        const frame: unknown = JSON.parse(String(event.data));
        if (
          typeof frame !== "object" ||
          frame === null ||
          !("type" in frame) ||
          frame.type !== "ready"
        ) {
          reject(new Error("WebSocket did not complete the hello handshake"));
          socket.close();
          return;
        }
        socket.close();
        resolve("open");
      } catch {
        reject(new Error("WebSocket returned a malformed hello response"));
        socket.close();
      }
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    };
  });
}
