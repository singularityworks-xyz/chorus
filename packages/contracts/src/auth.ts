import { z } from "zod";

/** Response from the authenticated, single-use WebSocket ticket endpoint. */
export const webSocketTicketResponseSchema = z.object({
  ticket: z.string().regex(/^[0-9a-f]{32}$/),
});

export type WebSocketTicketResponse = z.infer<
  typeof webSocketTicketResponseSchema
>;

/** One-time credential returned when an authenticated device pairs another. */
export const devicePairingTokenResponseSchema = z.object({
  expiresAt: z.number().finite().positive(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

export type DevicePairingTokenResponse = z.infer<
  typeof devicePairingTokenResponseSchema
>;
