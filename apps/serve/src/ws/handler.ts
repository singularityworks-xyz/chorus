import { WS_CLOSE_UNAUTHORIZED } from "@chorus/contracts";
import { Elysia, t } from "elysia";
import { verifyRequestCredential } from "../auth/guard";
import type { SessionRegistry } from "../auth/session-registry";
import type { TicketOptions } from "../auth/ticket";
import type { WorkspaceHub } from "./hub";
import type { HubSocket } from "./hub/types";

export const wsClientMessageSchema = t.Object({
  capabilities: t.Optional(t.Array(t.Literal("card.reordered"))),
  payload: t.Optional(t.Any()),
  since: t.Optional(t.Number()),
  type: t.String(),
  workspaceId: t.Optional(t.String()),
});

export interface WsHandlerOptions {
  hub: WorkspaceHub;
  sessionRegistry?: SessionRegistry;
  ticketOptions: TicketOptions;
  token: string;
}

function toHubSocket(context: unknown): HubSocket {
  const socket = context as {
    id?: string;
    raw?: { getBufferedAmount?: () => number };
    send: (data: string) => unknown;
  };
  const getBufferedAmount = socket.raw?.getBufferedAmount;

  return {
    id: socket.id ?? "",
    ...(typeof getBufferedAmount === "function"
      ? { getBufferedAmount: () => socket.raw?.getBufferedAmount?.() ?? 0 }
      : {}),
    send: (data) => socket.send(data),
  };
}

async function authorizeUpgrade(
  context: unknown,
  options: Pick<WsHandlerOptions, "sessionRegistry" | "ticketOptions" | "token">
): Promise<string | null> {
  const request = (context as { data?: { request?: Request } }).data?.request;
  if (!request) {
    return null;
  }

  const result = await verifyRequestCredential(request, {
    sessionRegistry: options.sessionRegistry,
    requireDevice: true,
    ticketOptions: options.ticketOptions,
    token: options.token,
  });

  return result.ok ? (result.deviceId ?? null) : null;
}

export function createWsHandler({
  hub,
  sessionRegistry,
  ticketOptions,
  token,
}: WsHandlerOptions) {
  const registrations = new Map<
    string,
    { closed: boolean; ready: Promise<boolean>; deviceId?: string }
  >();

  return new Elysia().ws("/ws", {
    body: wsClientMessageSchema,

    async open(ws) {
      const socket = toHubSocket(ws);
      const registration: {
        closed: boolean;
        ready: Promise<boolean>;
        deviceId?: string;
      } = {
        closed: false,
        ready: Promise.resolve(false),
      };
      registrations.set(socket.id, registration);

      registration.ready = Promise.resolve()
        .then(() =>
          authorizeUpgrade(ws, { sessionRegistry, ticketOptions, token })
        )
        .then((deviceId) => {
          if (registration.closed) {
            return false;
          }
          if (
            !deviceId ||
            (sessionRegistry && !sessionRegistry.deviceAllowed(deviceId))
          ) {
            ws.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
            return false;
          }

          registration.deviceId = deviceId;
          hub.register(socket, deviceId);
          return true;
        })
        .catch(() => {
          if (!registration.closed) {
            ws.close(1011, "authorization failed");
          }
          return false;
        });

      await registration.ready;
    },

    message(ws, message) {
      const socket = toHubSocket(ws);
      const registration = registrations.get(socket.id);
      if (!registration) {
        return;
      }

      registration.ready.then((registered) => {
        if (!registered || registration.closed) {
          return;
        }
        if (
          sessionRegistry &&
          !(
            registration.deviceId &&
            sessionRegistry.deviceAllowed(registration.deviceId)
          )
        ) {
          ws.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
          hub.unregister(socket);
          return;
        }

        hub.handleRawMessage(socket, JSON.stringify(message)).catch(() => {
          console.error("[ws] hub message error");
        });
      });
    },

    close(ws) {
      const socket = toHubSocket(ws);
      const registration = registrations.get(socket.id);
      if (registration) {
        registration.closed = true;
        registrations.delete(socket.id);
      }
      hub.unregister(socket);
    },
  });
}
