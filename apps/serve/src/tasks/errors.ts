export class SessionOwnershipError extends Error {
  readonly code: "session_ownership_conflict" | "session_directory_unknown";

  constructor(code: SessionOwnershipError["code"], message: string) {
    super(message);
    this.name = "SessionOwnershipError";
    this.code = code;
  }
}

export class BoardLifecycleError extends Error {
  readonly code: "board_closing" | "board_abort_failed";

  constructor(code: BoardLifecycleError["code"], message: string) {
    super(message);
    this.name = "BoardLifecycleError";
    this.code = code;
  }
}

export class GlobalModelNotConfiguredError extends Error {
  readonly code = "global_model_not_configured";

  constructor() {
    super("Choose one provider and model in Settings before starting a task.");
    this.name = "GlobalModelNotConfiguredError";
  }
}

export class BoardTaskCommandError extends Error {
  readonly code:
    | "board_not_found"
    | "board_busy"
    | "task_not_found"
    | "task_not_queued"
    | "task_not_retryable"
    | "task_not_abortable"
    | "abort_not_accepted"
    | "task_not_reviewable"
    | "task_session_missing"
    | "task_prompt_missing"
    | "task_review_invalid"
    | "prompt_dispatch_failed"
    | "session_not_available"
    | "session_busy"
    | "session_nothing_to_undo"
    | "session_nothing_to_redo"
    | "session_history_unavailable"
    | "session_command_failed";

  constructor(code: BoardTaskCommandError["code"], message: string) {
    super(message);
    this.name = "BoardTaskCommandError";
    this.code = code;
  }
}
