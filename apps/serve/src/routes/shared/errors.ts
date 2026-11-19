import { ReferenceLookupError } from "@chorus/oc-adapter";
import { UnregisteredRootError } from "../../auth/roots";
import { EngineUnavailableError } from "../../opencode/process-manager";
import { RepositoryRegistryError } from "../../projects/repository-registry";
import {
  BoardLifecycleError,
  BoardTaskCommandError,
  GlobalModelNotConfiguredError,
  SessionOwnershipError,
} from "../../tasks/errors";
import { UnknownSessionError } from "../../tasks/session-directory";
import { pendingApprovalConflictMessage } from "../../workspace/store";

function boardTaskCommandStatus(error: BoardTaskCommandError): number {
  switch (error.code) {
    case "board_not_found":
    case "task_not_found":
      return 404;
    case "task_prompt_missing":
    case "task_review_invalid":
      return 422;
    case "prompt_dispatch_failed":
    case "session_command_failed":
      return 502;
    case "session_history_unavailable":
      return 503;
    default:
      return 409;
  }
}

export function pendingApprovalConflict(
  status: "already_resolving" | "not_pending",
  set: { status?: number | string }
): { code: string; message: string } {
  set.status = 409;
  return {
    code: "pending_approval_conflict",
    message: pendingApprovalConflictMessage(status),
  };
}

export function mapRouteError(error: unknown): {
  code: string;
  message: string;
  status: number;
} | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (error instanceof EngineUnavailableError) {
    return { code: error.code, message: error.message, status: 503 };
  }
  if (error instanceof ReferenceLookupError) {
    return {
      code: "autocomplete_unavailable",
      message:
        "Could not load board suggestions. Check the provider connection and retry.",
      status: 502,
    };
  }
  if (error instanceof UnknownSessionError) {
    return { code: "unknown_session", message: error.message, status: 404 };
  }
  if (error instanceof UnregisteredRootError) {
    return { code: "unregistered_root", message: error.message, status: 400 };
  }
  if (error instanceof RepositoryRegistryError) {
    return {
      code: error.code,
      message: error.message,
      status: error.code === "unregistered_repository_root" ? 403 : 400,
    };
  }
  if (error instanceof SessionOwnershipError) {
    return {
      code: error.code,
      message: error.message,
      status: error.code === "session_directory_unknown" ? 503 : 409,
    };
  }
  if (error instanceof BoardLifecycleError) {
    return {
      code: error.code,
      message: error.message,
      status: error.code === "board_abort_failed" ? 504 : 409,
    };
  }
  if (error instanceof GlobalModelNotConfiguredError) {
    return { code: error.code, message: error.message, status: 409 };
  }
  if (error instanceof BoardTaskCommandError) {
    return {
      code: error.code,
      message: error.message,
      status: boardTaskCommandStatus(error),
    };
  }
  return null;
}
