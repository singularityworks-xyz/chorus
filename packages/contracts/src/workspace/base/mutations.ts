import { z } from "zod";
import { boardViewModeSchema, workspaceBoardSessionSchema } from "./boards";
import { modelSelectionSchema } from "./models";
import { boardSeedSchema } from "./projects";
import { reviewModeSchema, workspaceColumnIdSchema } from "./tasks";

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
    type: z.literal("board.task.reorder"),
    payload: z.object({
      beforeTaskId: z.string().min(1).nullable(),
      boardId: z.string().min(1),
      column: workspaceColumnIdSchema,
      taskId: z.string().min(1),
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
    type: z.literal("preference.default_model.set"),
    payload: z.object({
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

export type WorkspaceMutation = z.infer<typeof workspaceMutationSchema>;
