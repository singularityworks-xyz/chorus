import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Elysia } from "elysia";
import { WorkspaceStore } from "../../workspace/store";
import { createDeviceManagementRoutes } from "../device-routes";
import { authGuardHandler } from "../guard";
import { createLocalEntry } from "../local-entry";
import { DevicePairingTokenStore } from "../pairing";
import { createAuthRoutes } from "../routes";
import { SessionRegistry } from "../session-registry";

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((complete) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      complete();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      complete();
    });
    child.kill("SIGTERM");
  });
}

async function waitForWeb(origin: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("production frontend exited during startup");
    }
    try {
      const response = await fetch(`${origin}/login`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) {
        return;
      }
    } catch {
      /* The isolated frontend is still binding its port. */
    }
    await delay(100);
  }
  throw new Error("production frontend did not become ready");
}

/** Explicit build-stage HTTP check. No browser, engine, E2E runner or relay. */
async function main() {
  const repository = resolve(import.meta.dir, "../../../../..");
  const runtime = join(
    repository,
    "apps/web/.next/standalone/apps/web/server.js"
  );
  if (!existsSync(runtime)) {
    throw new Error(
      "Build the standalone frontend before verifying production entry"
    );
  }
  const nodeBinary = Bun.which("node");
  if (!nodeBinary) {
    throw new Error("Node.js is required to verify the standalone frontend");
  }
  const root = await mkdtemp(join(tmpdir(), "chorus-production-proxy-"));
  const store = new WorkspaceStore(root);
  const token = crypto.randomUUID();
  const registry = new SessionRegistry(store.meta, token);
  const backend = new Elysia()
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
        ticketStore: store.meta,
        isProduction: true,
        localOrigins: [],
        pairingTokenStore: new DevicePairingTokenStore(),
      })
    )
    .use(
      createDeviceManagementRoutes({
        token,
        registry,
        onRevoke: async () => undefined,
      })
    )
    .listen({ hostname: "127.0.0.1", port: 0 });
  // Reserve an OS-assigned port, then release it immediately before starting
  // this single hidden child. A collision fails rather than spawning retries.
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });
  const port = reservation.port;
  reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const local = createLocalEntry({ token, registry, webPort: port }).listen({
    hostname: "127.0.0.1",
    port: 0,
  });
  const child = spawn(nodeBinary, [runtime], {
    cwd: dirname(runtime),
    windowsHide: true,
    shell: false,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      CHORUS_SERVE_URL: `http://127.0.0.1:${backend.server?.port}`,
    },
  });
  let spawnError: Error | null = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  try {
    await waitForWeb(origin, child);
    if (spawnError) {
      throw spawnError;
    }
    const opened = await fetch(
      `http://127.0.0.1:${local.server?.port}/auth/local-session`,
      { method: "POST", headers: { origin, "x-chorus-local-bootstrap": "1" } }
    );
    assert.equal(opened.status, 200, "private production entry");
    const cookie = opened.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const allowed = await fetch(`${origin}/api/auth/device`, {
      method: "POST",
      headers: { cookie, origin },
    });
    assert.equal(
      allowed.status,
      200,
      "same-origin mutation through real Next standalone"
    );
    const forbidden = await fetch(`${origin}/api/auth/device`, {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
    });
    assert.equal(forbidden.status, 403, "foreign-origin mutation");
    const listed = await fetch(`${origin}/api/auth/devices`, {
      headers: { cookie },
    });
    assert.equal(listed.status, 200, "protected cookie forwarding");
    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie, origin },
    });
    assert.equal(logout.status, 200, "logout proxy");
    assert.ok(
      logout.headers
        .getSetCookie()
        .some((value) => value.startsWith("__Host-chorus_session=")),
      "protected cookie clearing"
    );
    assert.equal(
      (await fetch(`${origin}/api/auth/devices`, { headers: { cookie } }))
        .status,
      401,
      "revoked cookie replay"
    );
    console.log(
      "Production local entry, origin enforcement, cookie forwarding and logout replay: passed"
    );
  } finally {
    await stopChild(child);
    await local.stop(true);
    await backend.stop(true);
    await store.close();
    if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

await main();
