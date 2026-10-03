import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  E2E_REPO_DIR,
  ENGINE_LOG_FILE,
  ENGINE_PID_FILE,
  OPENCODE_PORT,
  repoRoot,
  SERVE_DATA_DIR,
  SERVE_LOG_FILE,
  SERVE_PID_FILE,
  SERVE_PORT,
  TOKEN,
} from "./serve-env";
import { start, startEngine, stop } from "./serve-process";

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

  seedFixtureRepo();

  // The engine first: serve adopts a running one rather than spawning its own,
  // and the agent specs need it reachable before the browser does.
  await stop(OPENCODE_PORT, ENGINE_PID_FILE);
  await startEngine({
    cwd: repoRoot,
    logFile: ENGINE_LOG_FILE,
    pidFile: ENGINE_PID_FILE,
    port: OPENCODE_PORT,
  });

  await start({
    dataDir: SERVE_DATA_DIR,
    // Adopt the engine the Playwright config started, so serve does not spawn a
    // second one on its own port.
    env: { OPENCODE_BASE_URL: `http://127.0.0.1:${String(OPENCODE_PORT)}` },
    logFile: SERVE_LOG_FILE,
    pidFile: SERVE_PID_FILE,
    port: SERVE_PORT,
    repoRoot,
    token: TOKEN,
  });
}

/**
 * Creates the throwaway repository the agent specs bind boards to.
 *
 * Idempotent: the data dir is wiped each run but this path is not, so an existing
 * fixture is reused rather than re-initialised.
 */
function seedFixtureRepo(): void {
  if (existsSync(join(E2E_REPO_DIR, ".git"))) {
    return;
  }

  mkdirSync(E2E_REPO_DIR, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: E2E_REPO_DIR });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], {
    cwd: E2E_REPO_DIR,
  });
  execFileSync("git", ["config", "user.name", "Chorus E2E"], {
    cwd: E2E_REPO_DIR,
  });
  writeFileSync(join(E2E_REPO_DIR, "README.md"), "# chorus e2e fixture\n");
  execFileSync("git", ["add", "-A"], { cwd: E2E_REPO_DIR });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: E2E_REPO_DIR,
  });
}
