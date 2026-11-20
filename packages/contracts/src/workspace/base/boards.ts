import { z } from "zod";
import { modelSelectionSchema } from "./models";
import { repoContextSchema } from "./projects";
import { columnsSchema, reviewModeSchema } from "./tasks";

export const boardSessionStateSchema = z.union([
  z.literal("uninitialized"),
  z.literal("starting"),
  z.literal("active"),
  z.literal("error"),
]);

export const workspaceBoardSessionSchema = z.object({
  currentTaskId: z.string().min(1).optional(),
  errorMessage: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  state: boardSessionStateSchema,
});

export const workspaceBoardSchema = z.object({
  boardId: z.string().min(1),
  columns: columnsSchema,
  modelSelection: modelSelectionSchema.nullable(),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }),
  repo: repoContextSchema,
  reviewMode: reviewModeSchema.optional().default("auto"),
  session: workspaceBoardSessionSchema,
  title: z.string().min(1),
});

export const workspaceHistoryEntrySchema = z.object({
  id: z.string().min(1),
  lastOpenedAt: z.number(),
  repo: repoContextSchema,
  title: z.string().min(1),
});

export const boardViewModeSchema = z.enum(["stacked", "relaxed"]);

export const workspacePreferencesSchema = z.object({
  boardViewMode: boardViewModeSchema.optional().default("relaxed"),
  composerHintDismissed: z.boolean(),
  defaultModelSelection: modelSelectionSchema
    .nullable()
    .optional()
    .default(null),
  recentlyUsedModels: modelSelectionSchema.array().default([]),
  speechVoiceId: z.string().min(1).nullable().optional().default(null),
});

export const workspaceSnapshotInputSchema = z.object({
  boards: z.array(workspaceBoardSchema),
  preferences: workspacePreferencesSchema,
  selectedBoardId: z.string().min(1).nullable(),
});

export const workspaceSnapshotSchema = workspaceSnapshotInputSchema.extend({
  previousWorkspaces: z.array(workspaceHistoryEntrySchema),
  revision: z.number().int().nonnegative(),
});

export type BoardViewMode = z.infer<typeof boardViewModeSchema>;

export type WorkspaceBoardSession = z.infer<typeof workspaceBoardSessionSchema>;

export type WorkspaceBoard = z.infer<typeof workspaceBoardSchema>;

export type WorkspaceHistoryEntry = z.infer<typeof workspaceHistoryEntrySchema>;

export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;

export type WorkspaceSnapshotInput = z.infer<
  typeof workspaceSnapshotInputSchema
>;

export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
