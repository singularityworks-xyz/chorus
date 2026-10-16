import { isAbsolute, relative } from "node:path";
import {
  portableRepositoryPathSchema,
  type WorkspaceBoard,
} from "@chorus/contracts";

/** Structured file references become portable relative paths; prose/history stays intact. */
export function portableTaskPaths(
  columns: WorkspaceBoard["columns"],
  checkout: string
): WorkspaceBoard["columns"] {
  function portable(path: string) {
    const local = isAbsolute(path) ? relative(checkout, path) : path;
    return portableRepositoryPathSchema.parse(local.replaceAll("\\", "/"));
  }
  return Object.fromEntries(
    Object.entries(columns).map(([column, tasks]) => [
      column,
      tasks.map((task) => ({
        ...task,
        taggedFiles: task.taggedFiles?.map(portable),
        changedFiles: task.changedFiles?.map((file) => ({
          ...file,
          path: portable(file.path),
        })),
        run: task.run
          ? {
              ...task.run,
              steps: task.run.steps.map((step) => ({
                ...step,
                filePath: step.filePath ? portable(step.filePath) : undefined,
              })),
            }
          : undefined,
      })),
    ])
  );
}
