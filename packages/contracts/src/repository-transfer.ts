import { z } from "zod";
import { sha256Schema } from "./hosting";

export const MAX_REPOSITORY_CHECKPOINT_BYTES = 256 * 1024 * 1024;
export const MAX_REPOSITORY_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_REPOSITORY_FILES = 20_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes at a filesystem trust seam
const INVALID_SEGMENT = /[\x00-\x1f\x7f\\:<>"|?*]|\p{Cf}/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Git refs cannot carry whitespace/control bytes
const FORBIDDEN_REF = /[\x00-\x20\x7f~^:?*[\\]|\p{Cf}/u;
const REF_ROOT = /^refs\/(?:heads|tags|remotes)\//;
const GIT_CONTROL_PATH = /^(?:\.git(?:~\d+)?|git~\d+)$/i;
const PATH_ENCODER = new TextEncoder();

function hasPathCollision(files: readonly { path: string }[]): boolean {
  const paths = new Set(files.map((file) => file.path.toLowerCase()));
  if (paths.size !== files.length) {
    return true;
  }
  return files.some((file) => {
    const parts = file.path.toLowerCase().split("/");
    return parts
      .slice(0, -1)
      .some((_, index) => paths.has(parts.slice(0, index + 1).join("/")));
  });
}

export const portableRepositoryPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => {
    if (
      path.normalize("NFC") !== path ||
      path.startsWith("/") ||
      path.split("/").length > 64
    ) {
      return false;
    }
    return path
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          PATH_ENCODER.encode(segment).length <= 255 &&
          !GIT_CONTROL_PATH.test(segment) &&
          segment.toLowerCase() !== ".chorus" &&
          segment.toLowerCase() !== ".chorus-worktrees" &&
          !segment.endsWith(".") &&
          !segment.endsWith(" ") &&
          !INVALID_SEGMENT.test(segment) &&
          !WINDOWS_DEVICE.test(segment)
      );
  }, "unsupported portable repository path");

export const gitObjectIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const portableGitRefSchema = z
  .string()
  .max(1024)
  .refine(
    (name) =>
      REF_ROOT.test(name) &&
      name.normalize("NFC") === name &&
      !FORBIDDEN_REF.test(name) &&
      !name.includes("..") &&
      !name.includes("@{") &&
      name
        .split("/")
        .every(
          (part) =>
            part &&
            !part.startsWith(".") &&
            !WINDOWS_DEVICE.test(part) &&
            PATH_ENCODER.encode(part).length <= 255 &&
            !part.endsWith(".") &&
            !part.endsWith(".lock")
        )
  );

export const checkpointContentSchema = z.strictObject({
  digest: sha256Schema,
  bytes: z.number().int().nonnegative().max(MAX_REPOSITORY_CHECKPOINT_BYTES),
});

export const repositoryCheckpointSchema = z
  .strictObject({
    version: z.literal(1),
    objectFormat: z.enum(["sha1", "sha256"]),
    head: gitObjectIdSchema.nullable(),
    branch: portableGitRefSchema.nullable(),
    refs: z
      .array(
        z.strictObject({ name: portableGitRefSchema, oid: gitObjectIdSchema })
      )
      .max(20_000),
    history: checkpointContentSchema.nullable(),
    staged: checkpointContentSchema,
    files: z
      .array(
        z.strictObject({
          path: portableRepositoryPathSchema,
          mode: z.enum(["100644", "100755"]),
          content: checkpointContentSchema.extend({
            bytes: z
              .number()
              .int()
              .nonnegative()
              .max(MAX_REPOSITORY_FILE_BYTES),
          }),
        })
      )
      .max(MAX_REPOSITORY_FILES),
  })
  .superRefine((value, context) => {
    const refs = new Set<string>();
    const length = value.objectFormat === "sha1" ? 40 : 64;
    if (
      (value.head && value.head.length !== length) ||
      value.refs.some((ref) => ref.oid.length !== length)
    ) {
      context.addIssue({
        code: "custom",
        message: "Git object format mismatch",
      });
    }
    if (hasPathCollision(value.files)) {
      context.addIssue({ code: "custom", message: "repository paths collide" });
    }
    for (const ref of value.refs) {
      if (refs.has(ref.name.toLowerCase())) {
        context.addIssue({ code: "custom", message: "duplicate Git ref" });
      }
      refs.add(ref.name.toLowerCase());
    }
    if (value.branch && !value.branch.startsWith("refs/heads/")) {
      context.addIssue({ code: "custom", message: "HEAD must name a branch" });
    }
    if ((value.head || value.refs.length) && !value.history) {
      context.addIssue({
        code: "custom",
        message: "committed history is missing",
      });
    }
    if (
      value.branch &&
      value.head &&
      value.refs.find((ref) => ref.name === value.branch)?.oid !== value.head
    ) {
      context.addIssue({
        code: "custom",
        message: "branch does not match HEAD",
      });
    }
    const total = value.files.reduce(
      (sum, file) => sum + file.content.bytes,
      value.staged.bytes + (value.history?.bytes ?? 0)
    );
    if (total > MAX_REPOSITORY_CHECKPOINT_BYTES) {
      context.addIssue({
        code: "custom",
        message: "repository checkpoint exceeds its byte limit",
      });
    }
  });

export type RepositoryCheckpoint = z.infer<typeof repositoryCheckpointSchema>;
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;
