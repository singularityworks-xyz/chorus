import { Elysia } from "elysia";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import type { BoardTaskService } from "../tasks/board-task-service";
import type { WorkspaceStore } from "../workspace/store";
import { createBoardAutocompleteRoutes } from "./boards/autocomplete";
import { createGitStatusRoutes } from "./git/status";
import { createSessionRoutes } from "./sessions/routes";
import type { HttpRouteDependencies } from "./shared/dependencies";
import { mapRouteError } from "./shared/errors";
import { createSnapshotRoutes } from "./snapshots/routes";
import { createSystemRoutes } from "./system/routes";
import { createBoardTaskRoutes } from "./tasks/board-lifecycle";
import { createSessionControlRoutes } from "./tasks/session-control";

export function createHttpRoutes(
  bridge: OpenCodeBridge,
  boardTasks: BoardTaskService,
  workspaceStore: WorkspaceStore
) {
  const dependencies: HttpRouteDependencies = {
    bridge,
    boardTasks,
    workspaceStore,
  };

  return new Elysia()
    .onError(({ error, set }) => {
      const mappedError = mapRouteError(error);
      if (!mappedError) {
        return undefined;
      }
      set.status = mappedError.status;
      return { code: mappedError.code, message: mappedError.message };
    })
    .use(createSystemRoutes(bridge))
    .use(createBoardAutocompleteRoutes(dependencies))
    .use(createBoardTaskRoutes(dependencies))
    .use(createSessionControlRoutes(dependencies))
    .use(createSessionRoutes(dependencies))
    .use(createSnapshotRoutes(dependencies))
    .use(createGitStatusRoutes(dependencies));
}
