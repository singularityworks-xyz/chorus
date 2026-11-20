export class EngineUnavailableError extends Error {
  readonly code = "engine_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}
