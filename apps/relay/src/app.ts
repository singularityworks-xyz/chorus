import { relayEnrollmentRequestSchema } from "@chorus/contracts";
import { Elysia } from "elysia";
import { z } from "zod";
import { INTERNAL_AUTH_HEADER, type RelayAuth } from "./auth";
import type { RelayConfig } from "./config";
import type { RelayEnrollment } from "./enrollment";
import { renderPortal } from "./portal";
import { RelayRateLimiter } from "./rate-limit";
import { type RelayRegistry, RelayRegistryError } from "./registry";

export function createRelayApp(options: {
  auth: RelayAuth;
  registry: RelayRegistry;
  enrollment: RelayEnrollment;
  config: RelayConfig;
}) {
  const { auth, registry, enrollment, config } = options;
  const limiter = new RelayRateLimiter();
  async function account(request: Request) {
    const session = await auth.auth.api.getSession({
      headers: request.headers,
    });
    return session?.user.emailVerified ? session : null;
  }

  return new Elysia({ serve: { maxRequestBodySize: 65_536 } })
    .onRequest(({ request, set }) => {
      set.headers["cache-control"] = "no-store";
      set.headers["x-content-type-options"] = "nosniff";
      set.headers["referrer-policy"] = "no-referrer";
      if (request.headers.has(INTERNAL_AUTH_HEADER)) {
        return new Response(null, { status: 400 });
      }
      const path = new URL(request.url).pathname;
      const key = request.headers.get("x-real-ip") ?? "unknown";
      if (!limiter.allow(key, 180)) {
        return Response.json(
          { code: "rate_limited" },
          { status: 429, headers: { "retry-after": "60" } }
        );
      }
      if (
        path.startsWith("/v1/") &&
        request.method !== "GET" &&
        path !== "/v1/enrollments" &&
        path !== "/v1/enrollments/poll" &&
        path !== "/v1/enrollments/ack" &&
        request.headers.get("origin") !== config.accountOrigin
      ) {
        return Response.json({ code: "origin_rejected" }, { status: 403 });
      }
    })
    .onError(({ error, set }) => {
      if (error instanceof RelayRegistryError) {
        set.status = error.code === "host_not_found" ? 404 : 409;
        return { code: error.code };
      }
      if (error instanceof z.ZodError) {
        set.status = 400;
        return { code: "invalid_request" };
      }
      set.status = 503;
      return { code: "relay_unavailable" };
    })
    .get("/health", () => ({ status: "ok" }))
    .get(
      "/assets/portal.js",
      () =>
        new Response(
          Bun.file(new URL("../dist/portal/client.js", import.meta.url)),
          { headers: { "content-type": "text/javascript; charset=utf-8" } }
        )
    )
    .get("/", () => renderPortal(config))
    .get("/sign-in", () => renderPortal(config))
    .get("/enroll/:id", ({ params }) => {
      z.uuid().parse(params.id);
      return renderPortal(config);
    })
    .all("/api/auth/*", ({ request }) => auth.auth.handler(request))
    .get("/.well-known/openid-configuration", ({ request }) => {
      const target = new URL(
        `${config.issuer}/.well-known/openid-configuration`
      );
      return auth.auth.handler(
        new Request(target.toString(), { headers: request.headers })
      );
    })
    .get("/v1/hosts", async ({ request, set }) => {
      const session = await account(request);
      if (!session) {
        set.status = 401;
        return { code: "unauthorized" };
      }
      const hosts = await registry.listHosts(session.user.id);
      return {
        hosts: hosts.map((host) => ({
          hostId: host.host_id,
          hostname: host.hostname,
          label: host.label,
          online: host.online,
        })),
      };
    })
    .delete("/v1/hosts/:id", async ({ request, params, set }) => {
      const session = await account(request);
      if (!session) {
        set.status = 401;
        return { code: "unauthorized" };
      }
      await registry.revokeHost(session.user.id, z.uuid().parse(params.id));
      return { revoked: true };
    })
    .post("/v1/enrollments", async ({ body, request, set }) => {
      if (
        !limiter.allow(
          `enroll:${request.headers.get("x-real-ip") ?? "unknown"}`,
          10
        )
      ) {
        set.status = 429;
        return { code: "rate_limited" };
      }
      return await enrollment.begin(relayEnrollmentRequestSchema.parse(body));
    })
    .post("/v1/enrollments/poll", ({ body }) => enrollment.poll(body))
    .post("/v1/enrollments/ack", ({ body }) => enrollment.poll(body, true))
    .get("/v1/enrollments/:id", async ({ request, params, set }) => {
      if (!(await account(request))) {
        set.status = 401;
        return { code: "unauthorized" };
      }
      return enrollment.describe(params.id);
    })
    .post("/v1/enrollments/:id/approve", async ({ request, params, set }) => {
      const session = await account(request);
      if (!session) {
        set.status = 401;
        return { code: "unauthorized" };
      }
      if (Date.now() - session.session.createdAt.getTime() > 600_000) {
        set.status = 403;
        return { code: "reauthentication_required" };
      }
      await enrollment.approve(params.id, session.user.id, request.headers);
      return { approved: true };
    });
}
