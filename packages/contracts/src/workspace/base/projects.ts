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

export type RepoProject = z.infer<typeof repoProjectSchema>;

export type RepoContext = z.infer<typeof repoContextSchema>;

export type BoardSeed = z.infer<typeof boardSeedSchema>;

export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
