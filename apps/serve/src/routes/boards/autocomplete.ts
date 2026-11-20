import {
  boardAutocompleteRequestSchema,
  boardAutocompleteResponseSchema,
} from "@chorus/contracts";
import { Elysia, t } from "elysia";
import { BoardTaskCommandError } from "../../tasks/errors";
import type { HttpRouteDependencies } from "../shared/dependencies";
import { normalizeAutocompletePath } from "./normalize";
export function createBoardAutocompleteRoutes({
  bridge,
  boardTasks,
  workspaceStore,
}: HttpRouteDependencies) {
  return new Elysia().get(
    "/boards/:boardID/autocomplete",
    async ({ params, query, set }) => {
      const parsed = boardAutocompleteRequestSchema.safeParse(query);
      if (!parsed.success) {
        set.status = 422;
        return {
          code: "invalid_autocomplete_request",
          message: "Choose a valid board suggestion lookup and try again.",
        };
      }

      const board = workspaceStore.getBoard(params.boardID);
      if (!board) {
        throw new BoardTaskCommandError(
          "board_not_found",
          "This board is no longer available. Reopen it and try again."
        );
      }

      boardTasks.assertBoardOpen(board.boardId);
      const directory = board.repo.worktree ?? board.repo.directory;
      await boardTasks.assertCheckoutAuthorized(directory);

      const request = parsed.data;
      switch (request.kind) {
        case "commands":
          return boardAutocompleteResponseSchema.parse({
            kind: request.kind,
            commands: await bridge.listAutocompleteCommands(directory),
          });
        case "skills":
          return boardAutocompleteResponseSchema.parse({
            kind: request.kind,
            skills: await bridge.listAutocompleteSkills(directory),
          });
        case "files":
          return boardAutocompleteResponseSchema.parse({
            kind: request.kind,
            files: (
              await bridge.findAutocompleteFiles(request.query, directory)
            ).map((entry) => entry.path),
          });
        case "directory": {
          const relativePath = normalizeAutocompletePath(request.path);
          if (relativePath === null) {
            set.status = 422;
            return {
              code: "invalid_autocomplete_path",
              message: "Choose a folder inside this board and try again.",
            };
          }
          return boardAutocompleteResponseSchema.parse({
            kind: request.kind,
            entries: await bridge.listAutocompleteDirectory(
              relativePath,
              directory
            ),
          });
        }
        default:
          set.status = 422;
          return {
            code: "invalid_autocomplete_request",
            message: "Choose a valid board suggestion lookup and try again.",
          };
      }
    },
    {
      params: t.Object({ boardID: t.String() }),
      query: t.Object({
        kind: t.Union([
          t.Literal("commands"),
          t.Literal("skills"),
          t.Literal("files"),
          t.Literal("directory"),
        ]),
        query: t.Optional(t.String({ maxLength: 256 })),
        path: t.Optional(t.String({ maxLength: 1024 })),
      }),
    }
  );
}
