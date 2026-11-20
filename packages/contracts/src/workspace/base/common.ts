import { z } from "zod";

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const acceptedCommandResponseSchema = z.object({
  accepted: z.boolean(),
});
