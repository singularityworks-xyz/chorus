import {
  ENGINE_PID_FILE,
  OPENCODE_PORT,
  SERVE_PID_FILE,
  SERVE_PORT,
} from "./serve-env";
import { stop } from "./serve-process";

/**
 * Stops the engine and serve after the run.
 *
 * Without this the next run inherits a live process and a warm event log, and
 * every resume assertion starts passing for the wrong reason.
 */
export default async function globalTeardown(): Promise<void> {
  await stop(SERVE_PORT, SERVE_PID_FILE);
  await stop(OPENCODE_PORT, ENGINE_PID_FILE);
}
