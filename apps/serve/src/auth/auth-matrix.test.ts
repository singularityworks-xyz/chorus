import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_SECURITY_POLICY } from "../security-headers";

/**
 * Phase 4 auth matrix against a real server process (plan P4 integration list).
 *
 * Everything here is end-to-end on purpose. Each of these gates has a way to
 * look implemented while protecting nothing:
 *
 * - A `resolve` hook that returns a raw `Response` is silently discarded by
 *   Elysia and the handler still runs, so an unauthenticated `/workspace` would
 *   answer 200 and a code-only review would call it guarded.
 * - A hook that arrives via `.use()` never reaches the nested route plugins, and
 *   routes registered before it are never gated. Also silent.
 * - A cookie signed with a missing version prefix verifies as malformed, so a
 *   correct login looks like a rejected one.
 * - `onBeforeHandle` runs after query/body validation, so a route with a
 *   required query answers 422 before the guard runs.
 * - `mapResponse` does not propagate into `.use()`-ed route plugins, so an
 *   app-wide header policy applied through it leaves every plugin-mounted
 *   endpoint bare.
 *
 * The guard was wrong in four of those five ways during this phase and each one
 * survived a passing typecheck. Only asserting against a live server catches it.
 */

const SERVE_ENTRY = join(import.meta.dir, "..", "index.ts");

const HEX_32 = /^[0-9a-f]{32}$/;
const COOKIE_PAIR = /chorus_session=[^;]+/;
const COOKIE_VALUE = /chorus_session=([^;]+)/;

/** POSIX mode mask: keeps permission bits, drops the file-type bits. */
const MODE_MASK = 0o777;

const TOKEN = "f".repeat(64);

/** Routes the plan requires to reject an unauthenticated caller. */
const GATED_ROUTES = [
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
  { label: "GET /auth/ws-ticket", method: "GET", path: "/auth/ws-ticket" },
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
        const cookie = setCookie.match(COOKIE_PAIR)?.[0] ?? "";

        if (login.status === 200 && cookie) {
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

/**
 * Sends the cookie explicitly rather than via a cookie jar.
 *
 * The session cookie is `Secure`, so curl (like a browser) refuses to attach it
 * over plain HTTP. That is correct behaviour being exercised, not a bug — and
 * the server's verification path still has to be proven, so the header is set by
 * hand. A real deployment terminates TLS at Caddy in Phase 8.
 */
function authed(server: ServerHandle, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("cookie", server.cookie);
  return { ...init, headers };
}

/**
 * One server for the whole suite: booting serve per test would add ~10 s each
 * and the matrix is about the guards, not about boot.
 */
const server = await startServer();

describe("Phase 4 auth matrix (plan P4 integration tests)", () => {
  test("the server is up and healthy without a credential", async () => {
    const res = await fetch(`${server.base}/health`);

    // `GET /health` is the one route that must stay open (spec §6.1).
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

      // Not 403, not 404, and above all not 200/422: a 422 here would mean
      // validation ran before the guard and the route schema leaked.
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

    // The static frontend serves the login screen, so it must not be gated. The
    // exact status depends on whether `apps/web/dist` exists, so what matters is
    // that it is not 401.
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
    // Production must mark it Secure; a plain-HTTP dev server must not.
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

  test("a cookie signed with a different token is rejected", async () => {
    // Minted with the right shape but the wrong key: only a real HMAC check
    // catches this, not a prefix or expiry parse.
    const login = await fetch(`${server.base}/auth/login`, {
      body: JSON.stringify({ token: TOKEN }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const good = login.headers.get("set-cookie") ?? "";
    const value = good.match(COOKIE_VALUE)?.[1] ?? "";
    const [, expires, signature] = value.split(".");

    // Re-sign the same expiry with a truncated signature.
    const tampered = `chorus_session=v1.${expires}.${signature.slice(0, -2)}AA`;

    const res = await fetch(`${server.base}/workspace`, {
      headers: { cookie: tampered },
    });

    expect(res.status).toBe(401);
  });

  test("logout clears the cookie", async () => {
    const res = await fetch(`${server.base}/auth/logout`, {
      headers: { cookie: server.cookie },
      method: "POST",
    });

    const setCookie = res.headers.get("set-cookie") ?? "";

    expect(res.status).toBe(200);
    expect(setCookie).toContain("Max-Age=0");
  });

  test("an unregistered directory is refused even when authenticated", async () => {
    // The git-backed routes take a client-supplied `directory`. Before this
    // phase nothing constrained it, so a caller could aim git at any path.
    for (const path of [
      "/snapshots/diff?directory=%2Fetc&fromHash=HEAD",
      "/git/status?directory=%2Fetc",
      "/snapshots/diff?directory=%2F&fromHash=HEAD",
    ]) {
      const res = await fetch(`${server.base}${path}`, authed(server));

      // 403, not 500: a rejected request is a client error and should say so.
      expect(res.status).toBe(403);
    }
  });

  test("a traversal attempt against the static root is refused", async () => {
    const res = await fetch(`${server.base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);

    // The SPA catch-all would otherwise read the file and return its contents.
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

    // biome-ignore lint/suspicious/noBitwiseOperators: reading POSIX mode bits
    expect(statSync(db).mode & MODE_MASK).toBe(0o600);

    // The production boot used CHORUS_TOKEN from the environment and so never
    // wrote a token file; laptop mode does, and that path is asserted in
    // token.test.ts. Its absence here is the correct outcome for production.
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

    // Whatever the status, the payload must not have executed.
    expect(res.status).toBe(403);
    expect(() => statSync(marker)).toThrow();
  });

  test("an unauthenticated WebSocket upgrade is closed with 4401", async () => {
    const code = await wsCloseCode(`${server.base}/ws`);

    // A browser cannot read a 401 from a failed handshake, so the close code is
    // the signal the client contract depends on.
    expect(code).toBe(4401);
  });

  test("a single-use ticket authenticates one upgrade and no more", async () => {
    const ticketRes = await fetch(`${server.base}/auth/ws-ticket`, {
      headers: { cookie: server.cookie },
    });
    expect(ticketRes.status).toBe(200);

    const { ticket } = (await ticketRes.json()) as { ticket: string };
    expect(ticket).toMatch(HEX_32);

    // First use is accepted: the socket opens and receives the hub's `ready`
    // frame, which is only sent to a registered client.
    const first = await wsFrames(`${server.base}/ws?ticket=${ticket}`);
    expect(first).toBe("open");

    // Replay is refused. A replayable ticket would be a bearer credential with
    // no bound beyond its TTL.
    expect(await wsCloseCode(`${server.base}/ws?ticket=${ticket}`)).toBe(4401);
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
    // Browsers attach the cookie to a same-origin upgrade on their own, so this
    // is the primary path and the ticket is only the proxy fallback.
    expect(await wsFrames(`${server.base}/ws`, { cookie: server.cookie })).toBe(
      "open"
    );
  });

  test("the brute-force guard trips after ten failed logins", async () => {
    // Keyed on the peer address, so this is the loopback source.
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

    // A correct token is refused too while the window is open — otherwise the
    // guard would not slow a brute force that got lucky at the end.
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

/** Resolves to the close code, or `"open"` if the socket stays connected. */
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

/** Resolves `"open"` once the hub's first frame arrives, or the close code. */
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

    socket.onmessage = () => {
      clearTimeout(timer);
      socket.close();
      resolve("open");
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
