import type { OpencodeModelSummary } from "@chorus/contracts";
import { createModelKey } from "@/features/models/components/model-picker/lib/model-key";
import type { WorkspaceBoard } from "@/features/workspace/types";
import { ChorusApiError } from "@/lib/chorus-api-error";

const PATH_SEPARATOR_RE = /[/\\]/;

export function getRepoBaseName(directory: string) {
  return directory.split(PATH_SEPARATOR_RE).filter(Boolean).at(-1) ?? directory;
}

export function getBoardRepoName(board: WorkspaceBoard) {
  return (
    board.repo.projectName?.trim() ||
    getRepoBaseName(board.repo.directory) ||
    board.title
  );
}

export function promptSubmissionErrorMessage(error: unknown): string {
  if (!(error instanceof ChorusApiError)) {
    return "We could not confirm whether the task started. Check the board before retrying; your draft is still here.";
  }
  if (error.code === "global_model_not_configured") {
    return "Choose one provider and model in Settings before starting a task.";
  }
  return error.message;
}

export function modelCatalogLoadErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Loading models timed out. Check provider settings and retry.";
  }
  return "Could not load models. Check provider settings and retry.";
}

export function preserveAvailableModelSelection(
  currentValue: string,
  models: OpencodeModelSummary[]
) {
  if (currentValue === "") {
    return currentValue;
  }
  return models.some((model) => createModelKey(model) === currentValue)
    ? currentValue
    : "";
}
