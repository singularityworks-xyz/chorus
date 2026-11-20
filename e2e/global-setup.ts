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
  SERVE_PID_FILE,
  SERVE_PORT,
} from "./serve-env";
import { startEngine, stop } from "./serve-process";

export default async function globalSetup(): Promise<void> {
  await stop(SERVE_PORT, SERVE_PID_FILE);

  rmSync(SERVE_DATA_DIR, { force: true, recursive: true });
  mkdirSync(SERVE_DATA_DIR, { recursive: true });

  seedFixtureRepo();

  await stop(OPENCODE_PORT, ENGINE_PID_FILE, "engine");
  await startEngine({
    cwd: repoRoot,
    logFile: ENGINE_LOG_FILE,
    pidFile: ENGINE_PID_FILE,
    port: OPENCODE_PORT,
  });
}

function seedFixtureRepo(): void {
  if (existsSync(join(E2E_REPO_DIR, ".git"))) {
    return;
  }

  mkdirSync(E2E_REPO_DIR, { recursive: true });
  execFileSync("git", ["init", "--quiet"], {
    cwd: E2E_REPO_DIR,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], {
    cwd: E2E_REPO_DIR,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "Chorus E2E"], {
    cwd: E2E_REPO_DIR,
    windowsHide: true,
  });
  writeFileSync(join(E2E_REPO_DIR, "README.md"), "# chorus e2e fixture\n");
  execFileSync("git", ["add", "-A"], {
    cwd: E2E_REPO_DIR,
    windowsHide: true,
  });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: E2E_REPO_DIR,
    windowsHide: true,
  });
}
