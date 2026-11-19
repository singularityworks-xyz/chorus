import { z } from "zod";

export const modelSelectionSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
});

export type ModelSelection = z.infer<typeof modelSelectionSchema>;
