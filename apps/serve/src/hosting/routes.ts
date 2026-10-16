import {
  hostEnrollmentBeginSchema,
  hostRemoteEnabledSchema,
} from "@chorus/contracts";
import { Elysia, status } from "elysia";
import { readSessionCookie, verifySessionCookie } from "../auth/session";
import type { SessionRegistry } from "../auth/session-registry";
import type { HostRemoteAccess } from "./remote-access";

export function createRemoteAccessRoutes(options: {
  token: string;
  registry: SessionRegistry;
  remote: HostRemoteAccess;
}) {
  return new Elysia()
    .onError(({ code, set }) => {
      set.status = code === "VALIDATION" ? 422 : 503;
      return {
        code:
          code === "VALIDATION"
            ? "invalid_request"
            : "remote_access_unavailable",
      };
    })
    .onRequest(async ({ request, set }) => {
      set.headers["cache-control"] = "no-store";
      const session = await verifySessionCookie(
        readSessionCookie(request.headers.get("cookie")),
        { token: options.token, registry: options.registry }
      );
      if (!session.ok) {
        return status(401, { code: "unauthorized" });
      }
    })
    .get("/hosting/remote", ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return options.remote.status();
    })
    .post(
      "/hosting/remote/enrollment",
      async ({ body, set }) => {
        set.headers["cache-control"] = "no-store";
        await options.remote.begin(body.label);
        return options.remote.status();
      },
      { body: hostEnrollmentBeginSchema }
    )
    .post(
      "/hosting/remote/connection",
      async ({ body, set }) => {
        set.headers["cache-control"] = "no-store";
        await options.remote.setEnabled(body.enabled);
        return options.remote.status();
      },
      { body: hostRemoteEnabledSchema }
    );
}
