import { z } from "zod";

const base64UrlKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(256);

export const pushSubscriptionSchema = z
  .object({
    endpoint: z.string().min(1).max(2048),
    expirationTime: z.number().int().positive().nullable().optional(),
    keys: z
      .object({
        auth: base64UrlKeySchema,
        p256dh: base64UrlKeySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((subscription, context) => {
    if (Math.floor((subscription.keys.p256dh.length * 3) / 4) !== 65) {
      context.addIssue({
        code: "custom",
        message: "p256dh must decode to a 65-byte P-256 public key",
        path: ["keys", "p256dh"],
      });
    }
    if (Math.floor((subscription.keys.auth.length * 3) / 4) < 16) {
      context.addIssue({
        code: "custom",
        message: "auth must decode to at least 16 bytes",
        path: ["keys", "auth"],
      });
    }
  });

export const pushConfigResponseSchema = z.object({
  deviceId: z.string().min(1),
  enabled: z.boolean(),
  publicKey: z.string().min(1).nullable(),
});

export const pushApprovalPayloadSchema = z.object({
  boardId: z.string().min(1).max(128),
  boardTitle: z.string().min(1).max(160),
  cardId: z.string().min(1).max(128),
  cardTitle: z.string().min(1).max(160),
  kind: z.enum(["permission", "question"]),
  requestId: z.string().min(1).max(256).optional(),
  url: z.string().regex(/^\/(?:\?[^#]*)?$/),
  version: z.literal(1),
});

export type PushApprovalPayload = z.infer<typeof pushApprovalPayloadSchema>;
export type PushConfigResponse = z.infer<typeof pushConfigResponseSchema>;
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
