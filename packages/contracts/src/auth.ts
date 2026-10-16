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

export const pairedDeviceListSchema = z.strictObject({
  currentDeviceId: z.string().regex(/^[a-f0-9]{32}$/),
  devices: z.array(
    z.strictObject({
      deviceId: z.string().regex(/^[a-f0-9]{32}$/),
      label: z.string().max(80),
      createdAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().positive(),
    })
  ),
});
export type PairedDeviceList = z.infer<typeof pairedDeviceListSchema>;

export const deviceRevocationResponseSchema = z.strictObject({
  revoked: z.literal(true),
  code: z.literal("device_cleanup_pending").optional(),
});

export const MAX_PAIRED_DEVICES = 10;
