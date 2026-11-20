export function taskActionErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "The request timed out. Refresh the board to check whether the action completed before retrying.";
  }
  if (error instanceof TypeError) {
    return "Could not reach Chorus. Check the connection and refresh the board before retrying.";
  }
  return error instanceof Error ? error.message : fallback;
}
