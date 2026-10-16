import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { hostRemoteStatusSchema } from "@chorus/contracts";
import { Elysia } from "elysia";
import { issueSessionCookie } from "../auth/session";
import { SessionRegistry } from "../auth/session-registry";
import { WorkspaceStore } from "../workspace/store";
import { HostRemoteAccess } from "./remote-access";
import { createRemoteAccessRoutes } from "./routes";

describe("remote host controls", () => {
  test("mounting controls does not authenticate or relabel unrelated parent routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "chorus-remote-mount-"));
    const store = new WorkspaceStore(root);
    const token = "test-mount-root";
    const registry = new SessionRegistry(store.meta, token);
    const remote = await HostRemoteAccess.open({
      dataDir: root,
      servePort: 2000,
      isProduction: true,
    });
    const app = new Elysia()
      .get("/health", () => ({ status: "ok" }))
      .use(createRemoteAccessRoutes({ token, registry, remote }))
      .get("/", () => "frontend")
      .post("/auth/login", () => ({ login: "reachable" }))
      .get("/outside/error", () => {
        throw new Error("external fixture failure");
      });
    try {
      expect(
        (await app.handle(new Request("http://localhost/health"))).status
      ).toBe(200);
      expect((await app.handle(new Request("http://localhost/"))).status).toBe(
        200
      );
      expect(
        (
          await app.handle(
            new Request("http://localhost/auth/login", { method: "POST" })
          )
        ).status
      ).toBe(200);
      const failure = await app.handle(
        new Request("http://localhost/outside/error")
      );
      expect(failure.status).toBe(500);
      expect(await failure.text()).not.toContain("remote_access_unavailable");
      expect(
        (await app.handle(new Request("http://localhost/hosting/remote")))
          .status
      ).toBe(401);
      expect(
        (
          await app.handle(
            new Request("http://localhost/hosting/remote/enrollment", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          )
        ).status
      ).toBe(401);
    } finally {
      await remote.close();
      await store.close();
      const target = resolve(root);
      if (target.startsWith(`${resolve(tmpdir())}${sep}`)) {
        await rm(target, { recursive: true, force: true });
      }
    }
  });
  test("keeps local access available without a relay installation and authenticates all controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "chorus-remote-control-"));
    const store = new WorkspaceStore(root);
    const token = "test-remote-control-root";
    const registry = new SessionRegistry(store.meta, token);
    const remote = await HostRemoteAccess.open({
      dataDir: root,
      servePort: 2000,
      isProduction: false,
    });
    const app = createRemoteAccessRoutes({ token, registry, remote });
    try {
      const makeRequest = (
        path: string,
        method: string,
        cookie?: string,
        body?: unknown
      ) =>
        new Request(`http://localhost/hosting/remote${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(cookie ? { cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      for (const [path, method] of [
        ["", "GET"],
        ["/enrollment", "POST"],
        ["/connection", "POST"],
      ]) {
        expect(
          (await app.handle(makeRequest(path ?? "", method ?? "GET"))).status
        ).toBe(401);
      }
      const session = await issueSessionCookie({ token, registry });
      const cookie = `chorus_session=${session.cookie}`;
      const response = await app.handle(makeRequest("", "GET", cookie));
      expect(response.status).toBe(200);
      expect(hostRemoteStatusSchema.parse(await response.json())).toMatchObject(
        {
          availability: "unconfigured",
          state: "disabled",
          enrolled: false,
          challenge: null,
          publicOrigin: null,
        }
      );
      expect(
        (
          await app.handle(
            makeRequest("/enrollment", "POST", cookie, { label: "Laptop" })
          )
        ).status
      ).toBe(503);
      expect(
        (
          await app.handle(
            makeRequest("/connection", "POST", cookie, { enabled: "yes" })
          )
        ).status
      ).toBe(422);
      registry.revokeDevice(session.deviceId ?? "");
      expect((await app.handle(makeRequest("", "GET", cookie))).status).toBe(
        401
      );
      const invalid = await HostRemoteAccess.open({
        installationFile: join(root, "missing.json"),
        dataDir: root,
        servePort: 2000,
        isProduction: true,
      });
      expect(invalid.status().availability).toBe("installation_error");
      await invalid.close();
      const development = await HostRemoteAccess.open({
        installationFile: join(root, "missing.json"),
        dataDir: root,
        servePort: 2000,
        isProduction: false,
      });
      expect(development.status().availability).toBe("production_required");
      await development.close();
    } finally {
      await remote.close();
      await store.close();
      if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
