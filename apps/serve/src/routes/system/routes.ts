import { Elysia } from "elysia";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
export function createSystemRoutes(bridge: Pick<OpenCodeBridge, "getStatus">) {
  return new Elysia()
    .get("/health", () => ({
      status: "ok",
      timestamp: Date.now(),
    }))

    .get("/bridge/status", () => bridge.getStatus());
}
