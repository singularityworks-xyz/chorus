import { z } from "zod";

/** Response from the authenticated, single-use WebSocket ticket endpoint. */
export const webSocketTicketResponseSchema = z.object({
  ticket: z.string().regex(/^[0-9a-f]{32}$/),
});

export type WebSocketTicketResponse = z.infer<
  typeof webSocketTicketResponseSchema
>;
