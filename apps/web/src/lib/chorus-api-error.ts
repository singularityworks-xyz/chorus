export class ChorusApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChorusApiError";
    this.code = code;
  }
}
