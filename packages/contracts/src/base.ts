import { z } from "zod";

export const repoProjectSchema = z.object({
  directory: z.string().min(1),
  worktree: z.string().min(1),
  projectId: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  sandboxes: z.array(z.string()).default([]),
});

export const repoContextSchema = repoProjectSchema.extend({
  branch: z.string().min(1).optional(),
});

export const gitStatusSchema = z.object({
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  branch: z.string().min(1),
  linesAdded: z.number().int().nonnegative().default(0),
  linesRemoved: z.number().int().nonnegative().default(0),
  modified: z.number().int().nonnegative().default(0),
  staged: z.number().int().nonnegative().default(0),
  tracking: z.string().nullable().optional(),
  untracked: z.number().int().nonnegative().default(0),
});

export type GitStatus = z.infer<typeof gitStatusSchema>;

export const boardSeedSchema = z.object({
  title: z.string().min(1),
  repo: repoContextSchema,
});

export const projectListResponseSchema = z.object({
  projects: z.array(repoProjectSchema),
});

export const modelSelectionSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
});

export const opencodeModelSummarySchema = z.object({
  attachment: z.boolean().default(false),
  connected: z.boolean(),
  modelID: z.string().min(1),
  name: z.string().min(1),
  providerID: z.string().min(1),
  providerName: z.string().min(1),
  reasoning: z.boolean().default(false),
  releaseDate: z.string().default(""),
  status: z
    .union([
      z.literal("active"),
      z.literal("alpha"),
      z.literal("beta"),
      z.literal("deprecated"),
    ])
    .optional(),
  temperature: z.boolean().default(false),
  toolCall: z.boolean().default(false),
});

export const opencodeModelCatalogSchema = z.object({
  defaultModel: modelSelectionSchema.optional(),
  models: z.array(opencodeModelSummarySchema),
});

export const opencodeProviderStatusSchema = z.object({
  connected: z.boolean(),
  id: z.string().min(1),
  modelCount: z.number().int().nonnegative(),
  name: z.string().min(1),
  supportsApi: z.boolean(),
  supportsOauth: z.boolean(),
});

export const opencodeProviderCatalogSchema = z.object({
  providers: z.array(opencodeProviderStatusSchema),
});

export const opencodeCredentialSummarySchema = z.object({
  id: z.string().min(1),
  type: z.union([z.literal("api"), z.literal("oauth"), z.literal("wellknown")]),
});

export const opencodeCredentialCatalogSchema = z.object({
  credentials: z.array(opencodeCredentialSummarySchema),
});

export const opencodeConfiguredProviderCatalogSchema = z.object({
  providerIDs: z.array(z.string().min(1)),
});

export const opencodeProviderAuthPromptTextSchema = z.object({
  key: z.string().min(1),
  message: z.string().min(1),
  placeholder: z.string().optional(),
  type: z.literal("text"),
  when: z
    .object({
      key: z.string().min(1),
      op: z.union([z.literal("eq"), z.literal("neq")]),
      value: z.string().min(1),
    })
    .optional(),
});

export const opencodeProviderAuthPromptSelectSchema = z.object({
  key: z.string().min(1),
  message: z.string().min(1),
  options: z.array(
    z.object({
      hint: z.string().optional(),
      label: z.string().min(1),
      value: z.string().min(1),
    })
  ),
  type: z.literal("select"),
  when: z
    .object({
      key: z.string().min(1),
      op: z.union([z.literal("eq"), z.literal("neq")]),
      value: z.string().min(1),
    })
    .optional(),
});

export const opencodeProviderAuthMethodSchema = z.object({
  label: z.string().min(1),
  prompts: z
    .array(
      z.union([
        opencodeProviderAuthPromptTextSchema,
        opencodeProviderAuthPromptSelectSchema,
      ])
    )
    .optional(),
  type: z.union([z.literal("oauth"), z.literal("api")]),
});

export const opencodeProviderAuthCatalogSchema = z.object({
  methods: z.array(opencodeProviderAuthMethodSchema),
});

export const opencodeProviderOauthAuthorizationSchema = z.object({
  instructions: z.string().min(1),
  method: z.union([z.literal("auto"), z.literal("code")]),
  url: z.string().min(1),
});

export const opencodeProviderApiAuthInputSchema = z.object({
  directory: z.string().min(1),
  key: z.string().min(1),
  providerID: z.string().min(1),
});

export const opencodeConfigureProviderInputSchema = z.object({
  directory: z.string().min(1).optional(),
  providerID: z.string().min(1),
});

export const opencodeProviderOauthAuthorizeInputSchema = z.object({
  directory: z.string().min(1),
  inputs: z.record(z.string(), z.string()).optional(),
  method: z.number().int().nonnegative(),
  providerID: z.string().min(1),
});

export const opencodeProviderOauthCallbackInputSchema = z.object({
  code: z.string().min(1),
  directory: z.string().min(1),
  method: z.number().int().nonnegative(),
  providerID: z.string().min(1),
});

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
  plan: z.string().optional(),
  questions: z.array(z.string()).optional(),
  run: agentRunContextSchema.optional(),
  runId: z.string().min(1).optional(),
  summary: z.string().optional(),
  taggedFiles: z.array(z.string()).optional(),
  title: z.string().min(1),
});

export const columnsSchema = z.record(z.string(), z.array(taskSchema));

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

export const workspaceMutationBaseSchema = z.object({
  baseRevision: z.number().int().nonnegative().nullable(),
  clientId: z.string().min(1),
  mutationId: z.string().min(1),
});

export const workspaceMutationSchema = z.discriminatedUnion("type", [
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.create"),
    payload: z.object({
      seed: boardSeedSchema,
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.remove"),
    payload: z.object({
      boardId: z.string().min(1),
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.select"),
    payload: z.object({
      boardId: z.string().min(1).nullable(),
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.move"),
    payload: z.object({
      boardId: z.string().min(1),
      position: z.object({
        x: z.number(),
        y: z.number(),
      }),
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.columns.replace"),
    payload: z.object({
      boardId: z.string().min(1),
      columns: columnsSchema,
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.session.patch"),
    payload: z.object({
      boardId: z.string().min(1),
      session: workspaceBoardSessionSchema.partial(),
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.model.set"),
    payload: z.object({
      boardId: z.string().min(1),
      model: modelSelectionSchema.nullable(),
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("preference.recently_used_models.add"),
    payload: z.object({
      model: modelSelectionSchema,
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("preference.dismiss_composer_hint"),
    payload: z.object({}),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("preference.speech_voice.set"),
    payload: z.object({
      voiceId: z.string().min(1).nullable(),
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("preference.board_view_mode.set"),
    payload: z.object({
      mode: boardViewModeSchema,
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("preference.set_voice"),
    payload: z.object({
      voice: z.string().min(1),
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.review_mode.set"),
    payload: z.object({
      boardId: z.string().min(1),
      reviewMode: reviewModeSchema,
    }),
  }),
  workspaceMutationBaseSchema.extend({
    type: z.literal("board.task.plan.update"),
    payload: z.object({
      boardId: z.string().min(1),
      taskId: z.string().min(1),
      plan: z.string(),
      questions: z.array(z.string()).optional(),
    }),
  }),
]);

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
  createdSession: z.boolean(),
  accepted: z.boolean(),
  timestamp: z.number(),
});

export type RepoProject = z.infer<typeof repoProjectSchema>;
export type RepoContext = z.infer<typeof repoContextSchema>;
export type BoardSeed = z.infer<typeof boardSeedSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type OpencodeModelSummary = z.infer<typeof opencodeModelSummarySchema>;
export type OpencodeModelCatalog = z.infer<typeof opencodeModelCatalogSchema>;
export type OpencodeProviderStatus = z.infer<
  typeof opencodeProviderStatusSchema
>;
export type OpencodeProviderCatalog = z.infer<
  typeof opencodeProviderCatalogSchema
>;
export type OpencodeCredentialSummary = z.infer<
  typeof opencodeCredentialSummarySchema
>;
export type OpencodeCredentialCatalog = z.infer<
  typeof opencodeCredentialCatalogSchema
>;
export type OpencodeConfiguredProviderCatalog = z.infer<
  typeof opencodeConfiguredProviderCatalogSchema
>;
export type OpencodeProviderAuthMethod = z.infer<
  typeof opencodeProviderAuthMethodSchema
>;
export type OpencodeProviderAuthCatalog = z.infer<
  typeof opencodeProviderAuthCatalogSchema
>;
export type OpencodeProviderOauthAuthorization = z.infer<
  typeof opencodeProviderOauthAuthorizationSchema
>;
export type OpencodeProviderApiAuthInput = z.infer<
  typeof opencodeProviderApiAuthInputSchema
>;
export type OpencodeConfigureProviderInput = z.infer<
  typeof opencodeConfigureProviderInputSchema
>;
export type OpencodeProviderOauthAuthorizeInput = z.infer<
  typeof opencodeProviderOauthAuthorizeInputSchema
>;
export type OpencodeProviderOauthCallbackInput = z.infer<
  typeof opencodeProviderOauthCallbackInputSchema
>;
export type AgentStep = z.infer<typeof agentStepSchema>;
export type AgentRunContext = z.infer<typeof agentRunContextSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Columns = z.infer<typeof columnsSchema>;
export type BoardViewMode = z.infer<typeof boardViewModeSchema>;
export type WorkspaceBoardSession = z.infer<typeof workspaceBoardSessionSchema>;
export type WorkspaceBoard = z.infer<typeof workspaceBoardSchema>;
export type WorkspaceHistoryEntry = z.infer<typeof workspaceHistoryEntrySchema>;
export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;
export type WorkspaceSnapshotInput = z.infer<
  typeof workspaceSnapshotInputSchema
>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type WorkspaceMutation = z.infer<typeof workspaceMutationSchema>;
export type QueueBoardPromptInput = z.infer<typeof queueBoardPromptInputSchema>;
export type QueueBoardPromptResponse = z.infer<
  typeof queueBoardPromptResponseSchema
>;
