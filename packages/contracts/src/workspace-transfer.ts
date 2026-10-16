import { z } from "zod";
import {
  agentRunContextSchema,
  agentStepSchema,
  taskSchema,
  workspaceBoardSchema,
  workspaceHistoryEntrySchema,
  workspacePreferencesSchema,
} from "./base";
import { workspaceAuthoritySchema } from "./hosting";
import { portableRepositoryPathSchema } from "./repository-transfer";

const portableTaskSchema = taskSchema.extend({
  taggedFiles: z.array(portableRepositoryPathSchema).optional(),
  changedFiles: z
    .array(
      taskSchema.shape.changedFiles
        .unwrap()
        .element.extend({ path: portableRepositoryPathSchema })
    )
    .optional(),
  run: agentRunContextSchema
    .extend({
      steps: z.array(
        agentStepSchema.extend({
          filePath: portableRepositoryPathSchema.optional(),
        })
      ),
    })
    .optional(),
});

/** Filesystem roots and engine project identifiers are replaced with checkpoint IDs. */
export const portableRepoContextSchema = z.strictObject({
  repositoryId: z.uuid(),
  checkoutId: z.uuid(),
  sandboxCheckoutIds: z.array(z.uuid()).max(100),
  projectName: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});
export const portableWorkspaceStateSchema = z
  .strictObject({
    version: z.literal(1),
    authority: workspaceAuthoritySchema,
    boards: z
      .array(
        workspaceBoardSchema.omit({ repo: true, columns: true }).extend({
          repo: portableRepoContextSchema,
          columns: z.record(z.string(), z.array(portableTaskSchema)),
        })
      )
      .max(1000),
    preferences: workspacePreferencesSchema,
    previousWorkspaces: z
      .array(
        workspaceHistoryEntrySchema
          .omit({ repo: true })
          .extend({ repo: portableRepoContextSchema })
      )
      .max(1000),
    revision: z.number().int().nonnegative().safe(),
    selectedBoardId: z.string().min(1).nullable(),
  })
  .superRefine((value, context) => {
    const boards = new Set(value.boards.map((board) => board.boardId));
    const history = new Set(value.previousWorkspaces.map((entry) => entry.id));
    const tasks = value.boards.flatMap((board) =>
      Object.values(board.columns)
        .flat()
        .map((task) => task.id)
    );
    if (
      boards.size !== value.boards.length ||
      history.size !== value.previousWorkspaces.length ||
      new Set(tasks).size !== tasks.length ||
      tasks.length > 20_000 ||
      (value.selectedBoardId !== null && !boards.has(value.selectedBoardId))
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid workspace identities or selection",
      });
    }
  });
export type PortableWorkspaceState = z.infer<
  typeof portableWorkspaceStateSchema
>;
