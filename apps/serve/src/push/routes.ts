import { Elysia, t } from "elysia";
import { z } from "zod";
import { deviceIdFromHeader } from "../auth/device";
import type { WorkspaceStore } from "../workspace/store";
import type { PushConfiguration } from "./config";
import {
  assertSafePushEndpoint,
  pushSubscriptionInputSchema,
} from "./subscriptions";

const MAX_SUBSCRIPTIONS_PER_DEVICE = 4;

export interface PushRouteOptions {
  allowedHosts?: string[];
  configuration: PushConfiguration;
  store: WorkspaceStore;
  token: string;
}

function invalidDevice() {
  return { code: "device_identity_required" };
}

const unsubscribeSchema = z
  .object({ endpoint: z.string().min(1).max(2048) })
  .strict();

export function createPushRoutes(options: PushRouteOptions) {
  return new Elysia()
    .get("/auth/push-config", async ({ request, set }) => {
      const device = await deviceIdFromHeader(
        request.headers.get("cookie"),
        options.token
      );
      if (!device.ok) {
        set.status = 401;
        return invalidDevice();
      }
      return {
        deviceId: device.deviceId,
        enabled: options.configuration.enabled,
        publicKey: options.configuration.publicKey,
      };
    })
    .post(
      "/auth/push-subscriptions",
      async ({ body, request, set }) => {
        if (!(options.configuration.enabled && options.configuration.keyId)) {
          set.status = 503;
          return { code: "push_disabled" };
        }
        const device = await deviceIdFromHeader(
          request.headers.get("cookie"),
          options.token
        );
        if (!device.ok) {
          set.status = 401;
          return invalidDevice();
        }

        const parsed = pushSubscriptionInputSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 422;
          return { code: "invalid_push_subscription" };
        }
        try {
          await assertSafePushEndpoint(parsed.data.endpoint, {
            allowedHosts: options.allowedHosts,
          });
        } catch {
          set.status = 422;
          return { code: "unsupported_push_endpoint" };
        }

        const now = Date.now();
        const saved = await options.store.upsertPushSubscription(
          {
            createdAt: now,
            deviceId: device.deviceId,
            endpoint: parsed.data.endpoint,
            expirationAt: parsed.data.expirationTime ?? null,
            keyId: options.configuration.keyId,
            keys: JSON.stringify(parsed.data.keys),
            updatedAt: now,
          },
          MAX_SUBSCRIPTIONS_PER_DEVICE
        );
        if (saved === "owned-by-another-device") {
          set.status = 409;
          return { code: "subscription_owned_by_another_device" };
        }
        if (saved === "limit-reached") {
          set.status = 409;
          return { code: "device_subscription_limit_reached" };
        }
        return { enabled: true };
      },
      { body: t.Any() }
    )
    .delete(
      "/auth/push-subscriptions",
      async ({ body, request, set }) => {
        const device = await deviceIdFromHeader(
          request.headers.get("cookie"),
          options.token
        );
        if (!device.ok) {
          set.status = 401;
          return invalidDevice();
        }
        const parsed = unsubscribeSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 422;
          return { code: "invalid_push_subscription" };
        }
        const removed = await options.store.deletePushSubscription(
          parsed.data.endpoint,
          device.deviceId
        );
        return { removed };
      },
      { body: t.Any() }
    );
}
