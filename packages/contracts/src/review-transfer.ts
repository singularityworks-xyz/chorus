import { z } from "zod";
import {
  checkpointContentSchema,
  gitObjectIdSchema,
} from "./repository-transfer";

/** Explicit tree roots only; source Git config, indexes and unrelated objects stay private. */
export const reviewCheckpointSchema = z
  .strictObject({
    version: z.literal(1),
    objectFormat: z.enum(["sha1", "sha256"]),
    trees: z.array(gitObjectIdSchema).min(1).max(10_000),
    objects: checkpointContentSchema,
  })
  .superRefine((value, context) => {
    const length = value.objectFormat === "sha1" ? 40 : 64;
    if (
      new Set(value.trees).size !== value.trees.length ||
      value.trees.some((tree) => tree.length !== length)
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid review tree roots",
      });
    }
  });
export type ReviewCheckpoint = z.infer<typeof reviewCheckpointSchema>;
