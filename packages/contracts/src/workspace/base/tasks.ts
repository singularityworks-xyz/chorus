import { z } from "zod";
import { modelSelectionSchema } from "./models";

export const agentStepKindSchema = z.union([
  z.literal("thinking"),
  z.literal("response"),
  z.literal("file_edit"),
  z.literal("tool_call"),
  z.literal("command"),
]);

export const agentStepStatusSchema = z.union([
  z.literal("running"),
  z.literal("done"),
  z.literal("error"),
]);

export const agentStepSchema = z.object({
  content: z.string().optional(),
  filePath: z.string().optional(),
  id: z.string().min(1),
  kind: agentStepKindSchema,
  linesAdded: z.number().optional(),
  linesRemoved: z.number().optional(),
  modifiedContent: z.string().optional(),
  originalContent: z.string().optional(),
  status: agentStepStatusSchema,
  summary: z.string().min(1),
});

export const agentRunContextSchema = z.object({
  elapsed: z.string().min(1),
  model: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  startedAt: z.number().optional(),
  steps: z.array(agentStepSchema),
  taskTitle: z.string().min(1),
});

export const reviewModeSchema = z.union([
  z.literal("manual"),
  z.literal("auto"),
]);

export const questionOptionSchema = z.object({
  description: z.string(),
  label: z.string(),
});

export const questionInfoSchema = z.object({
  custom: z.boolean().optional(),
  header: z.string(),
  multiple: z.boolean().optional(),
  options: z.array(questionOptionSchema),
  question: z.string(),
});

export const pendingApprovalRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("permission"),
    permission: z.string().optional(),
    requestId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("question"),
    questions: z.array(questionInfoSchema),
    requestId: z.string().min(1).optional(),
  }),
]);

export const pendingQuestionSchema = z.object({
  id: z.string().min(1),
  questions: z.array(questionInfoSchema),
  sessionID: z.string().min(1),
});

export const pendingQuestionsResponseSchema = z.object({
  questions: z.array(pendingQuestionSchema),
  timestamp: z.number(),
});

export type PendingApprovalRequest = z.infer<
  typeof pendingApprovalRequestSchema
>;

export const promptFilePartSchema = z.object({
  type: z.literal("file"),
  filename: z.string(),
  path: z.string(),
  mime: z.string().optional(),
  isDirectory: z.boolean().optional(),
  lineRange: z.object({ start: z.number(), end: z.number() }).optional(),
});

export const promptPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  promptFilePartSchema,
]);

export const taskPromptInputSchema = z.object({
  agent: z.string().min(1).optional(),
  model: modelSelectionSchema.optional(),
  parts: z.array(promptPartSchema).optional(),
  reviewMode: reviewModeSchema,
  text: z.string().min(1),
});

export const taskOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
  "awaiting_review",
]);

export const taskSchema = z.object({
  changedFiles: z
    .array(
      z.object({
        added: z.number(),
        path: z.string(),
        removed: z.number(),
      })
    )
    .optional(),
  id: z.string().min(1),
  label: z.string().min(1),
  labelVariant: z.union([
    z.literal("primary-light"),
    z.literal("success-light"),
    z.literal("warning-light"),
    z.literal("destructive-light"),
    z.literal("info-light"),
  ]),
  linesAdded: z.number().optional(),
  linesRemoved: z.number().optional(),
  errorMessage: z.string().optional(),
  plan: z.string().optional(),
  pendingApproval: pendingApprovalRequestSchema.optional(),
  pendingApprovals: z.array(pendingApprovalRequestSchema).optional(),
  promptInput: taskPromptInputSchema.optional(),
  questionAnswers: z.array(z.string()).optional(),
  questions: z.array(z.string()).optional(),
  retryOf: z.string().min(1).optional(),
  reviewApproved: z.boolean().optional(),
  run: agentRunContextSchema.optional(),
  runId: z.string().min(1).optional(),
  outcome: taskOutcomeSchema.optional(),
  summary: z.string().optional(),
  taggedFiles: z.array(z.string()).optional(),
  title: z.string().min(1),
});

export const columnsSchema = z.record(z.string(), z.array(taskSchema));

export const workspaceColumnIdSchema = z.enum([
  "queue",
  "in_progress",
  "approve",
  "done",
]);

export type AgentStep = z.infer<typeof agentStepSchema>;

export type AgentRunContext = z.infer<typeof agentRunContextSchema>;

export type TaskPromptInput = z.infer<typeof taskPromptInputSchema>;

export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;

export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

export type QuestionInfo = z.infer<typeof questionInfoSchema>;

export type Task = z.infer<typeof taskSchema>;

export type Columns = z.infer<typeof columnsSchema>;
