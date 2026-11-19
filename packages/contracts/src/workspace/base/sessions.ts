import { z } from "zod";

export const boardSessionHistoryCommandSchema = z.enum(["undo", "redo"]);

export const boardSessionHistoryStateSchema = z.object({
  boardId: z.string().min(1),
  canRedo: z.boolean(),
  canUndo: z.boolean(),
  busy: z.boolean(),
  sessionId: z.string().min(1).nullable(),
  timestamp: z.number(),
});

export const boardSessionHistoryCommandResponseSchema = z.object({
  accepted: z.literal(true),
  boardId: z.string().min(1),
  command: boardSessionHistoryCommandSchema,
  sessionId: z.string().min(1),
  timestamp: z.number(),
});

export type BoardSessionHistoryCommand = z.infer<
  typeof boardSessionHistoryCommandSchema
>;

export type BoardSessionHistoryState = z.infer<
  typeof boardSessionHistoryStateSchema
>;

export type BoardSessionHistoryCommandResponse = z.infer<
  typeof boardSessionHistoryCommandResponseSchema
>;
