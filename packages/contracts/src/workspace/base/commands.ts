import { z } from "zod";
import { modelSelectionSchema } from "./models";
import { promptPartSchema, reviewModeSchema } from "./tasks";

export const queueBoardPromptInputSchema = z.object({
  boardId: z.string().min(1),
  directory: z.string().min(1),
  projectId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  text: z.string().min(1),
  agent: z.string().min(1).optional(),
  model: modelSelectionSchema.optional(),
  parts: z.array(promptPartSchema).optional(),
  reviewMode: reviewModeSchema.optional().default("auto"),
});

export const queueBoardPromptResponseSchema = z.object({
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  createdSession: z.boolean(),
  accepted: z.boolean(),
  timestamp: z.number(),
});

export const boardTaskCommandResponseSchema = z.object({
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.union([z.literal("accepted"), z.literal("already_running")]),
  taskId: z.string().min(1),
  retryOf: z.string().min(1).optional(),
  timestamp: z.number(),
});

export const boardTaskFinalizeReviewInputSchema = z.object({
  answers: z.array(z.string()).optional(),
  plan: z.string(),
});

export type QueueBoardPromptInput = z.infer<typeof queueBoardPromptInputSchema>;

export type QueueBoardPromptResponse = z.infer<
  typeof queueBoardPromptResponseSchema
>;

export type BoardTaskCommandResponse = z.infer<
  typeof boardTaskCommandResponseSchema
>;

export type BoardTaskFinalizeReviewInput = z.infer<
  typeof boardTaskFinalizeReviewInputSchema
>;
