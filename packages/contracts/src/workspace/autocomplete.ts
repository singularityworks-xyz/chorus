import { z } from "zod";

export const boardAutocompleteRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commands") }),
  z.object({ kind: z.literal("skills") }),
  z.object({
    kind: z.literal("files"),
    query: z.string().max(256).default(""),
  }),
  z.object({
    kind: z.literal("directory"),
    path: z.string().max(1024).default("/"),
  }),
]);

const autocompleteCommandSchema = z.object({
  description: z.string().optional(),
  name: z.string().min(1),
});

const autocompleteFileSchema = z.object({
  path: z.string().min(1),
  type: z.enum(["file", "directory"]),
});

export const boardAutocompleteResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    commands: z.array(autocompleteCommandSchema),
    kind: z.literal("commands"),
  }),
  z.object({
    kind: z.literal("skills"),
    skills: z.array(autocompleteCommandSchema),
  }),
  z.object({
    files: z.array(z.string().min(1)),
    kind: z.literal("files"),
  }),
  z.object({
    entries: z.array(autocompleteFileSchema),
    kind: z.literal("directory"),
  }),
]);

export type BoardAutocompleteRequest = z.infer<
  typeof boardAutocompleteRequestSchema
>;
export type BoardAutocompleteResponse = z.infer<
  typeof boardAutocompleteResponseSchema
>;
