import { Elysia } from "elysia";
import { readSessionCookie, verifySessionCookie } from "./session";
import type { SessionRegistry } from "./session-registry";

export function createDeviceManagementRoutes(options: {
  token: string;
  registry: SessionRegistry;
  onRevoke: (deviceId: string) => Promise<void>;
}) {
  async function identity(request: Request) {
    return await verifySessionCookie(
      readSessionCookie(request.headers.get("cookie")),
      { token: options.token, registry: options.registry }
    );
  }
  return new Elysia()
    .get("/auth/devices", async ({ request, set }) => {
      set.headers["cache-control"] = "no-store";
      const session = await identity(request);
      if (!(session.ok && session.deviceId)) {
        set.status = 401;
        return { code: "unauthorized" };
      }
      options.registry.prune();
      return {
        currentDeviceId: session.deviceId,
        devices: options.registry
          .list()
          .filter((device) => device.revokedAt === null)
          .map(({ deviceId, label, createdAt, expiresAt }) => ({
            deviceId,
            label,
            createdAt,
            expiresAt,
          })),
      };
    })
    .delete("/auth/devices/:id", async ({ request, params, set }) => {
      set.headers["cache-control"] = "no-store";
      const session = await identity(request);
      if (!session.ok) {
        set.status = 401;
        return { code: "unauthorized" };
      }
      if (!options.registry.revokeDevice(params.id)) {
        set.status = 404;
        return { code: "device_not_found" };
      }
      try {
        await options.onRevoke(params.id);
      } catch {
        set.status = 503;
        return { revoked: true, code: "device_cleanup_pending" };
      }
      return { revoked: true };
    });
}
