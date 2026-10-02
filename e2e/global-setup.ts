import { mkdirSync, rmSync } from "node:fs";
import {
  repoRoot,
  SERVE_DATA_DIR,
  SERVE_LOG_FILE,
  SERVE_PID_FILE,
  SERVE_PORT,
  TOKEN,
} from "./serve-env";
import { start, stop } from "./serve-process";

/**
 * Starts serve for the whole run.
 *
 * The spec needs to stop and restart it mid-test, which Playwright's own
 * `webServer` supervision cannot allow, so the process is owned here and its pid
 * published for the specs to read.
 */
export default async function globalSetup(): Promise<void> {
  // A leftover serve on the port would be reused and silently inherit a stale
  // event log, which is exactly the kind of cross-run state that makes a sync
  // suite lie about resume.
  await stop(SERVE_PORT, SERVE_PID_FILE);

  rmSync(SERVE_DATA_DIR, { force: true, recursive: true });
  mkdirSync(SERVE_DATA_DIR, { recursive: true });

  await start({
    dataDir: SERVE_DATA_DIR,
    logFile: SERVE_LOG_FILE,
    pidFile: SERVE_PID_FILE,
    port: SERVE_PORT,
    repoRoot,
    token: TOKEN,
  });
}
