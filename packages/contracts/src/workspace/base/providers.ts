import { z } from "zod";
import { modelSelectionSchema } from "./models";

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

export const opencodeConfigureProviderResponseSchema = z.object({
  configured: z.boolean(),
  providerIDs: z.array(z.string().min(1)),
});

export const opencodeModelsDialogResponseSchema = z.object({
  opened: z.boolean(),
});

export const opencodeAuthLoginResponseSchema = z.object({
  launched: z.boolean(),
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
