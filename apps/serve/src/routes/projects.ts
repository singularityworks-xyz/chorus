import { createLogger } from "@chorus/logger";
import { Elysia } from "elysia";
import { FolderPickerUnavailableError } from "../projects/folder-picker";
import type { ProjectService } from "../projects/service";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "SERVE:PROJECT-ROUTES"
);

export function createProjectRoutes(
  projectService: Pick<ProjectService, "listProjects" | "openFolder">,
  isProduction = false
) {
  return new Elysia()
    .get("/projects", () => {
      logger.debug("route:projects");
      return projectService.listProjects();
    })
    .post("/projects/open-folder", async ({ set }) => {
      if (isProduction) {
        set.status = 503;
        return {
          code: "host_folder_picker_disabled",
          message:
            "Configure CHORUS_REPOSITORY_ROOTS to add repositories on this server",
        };
      }
      try {
        return await projectService.openFolder();
      } catch (error) {
        if (error instanceof FolderPickerUnavailableError) {
          set.status = 503;
          return {
            code: "folder_picker_unavailable",
            message: error.message,
          };
        }
        throw error;
      }
    });
}
