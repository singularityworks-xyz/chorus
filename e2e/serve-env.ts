import { tmpdir } from "node:os";
import { join } from "node:path";

export const SERVE_PORT = Number(process.env.CHORUS_E2E_SERVE_PORT ?? 2199);
export const OPENCODE_PORT = Number(
  process.env.CHORUS_E2E_OPENCODE_PORT ?? 4199
);
export const WEB_PORT = Number(process.env.CHORUS_E2E_WEB_PORT ?? 3199);
export const TOKEN =
  "e2e00000000000000000000000000000000000000000000000000000000000000";

const repoRoot = process.cwd();

const runDirectory =
  process.env.CHORUS_E2E_DATA_DIR ?? join(tmpdir(), "chorus-e2e");

export const SERVE_DATA_DIR = join(runDirectory, "workspace");
export const SERVE_LOG_FILE = join(runDirectory, "serve.log");
export const SERVE_PID_FILE = `${runDirectory}/serve.pid`;
export const ENGINE_LOG_FILE = `${runDirectory}/opencode.log`;
export const ENGINE_PID_FILE = `${runDirectory}/opencode.pid`;

export const E2E_REPO_DIR =
  process.env.CHORUS_E2E_REPO_DIR ?? join(tmpdir(), "chorus-e2e-repo");

export const E2E_SERVE_ENV = {
  CHORUS_REPOSITORY_ROOTS: JSON.stringify([repoRoot, E2E_REPO_DIR]),
  OPENCODE_DIRECTORY: E2E_REPO_DIR,
  OPENCODE_BASE_URL: `http://127.0.0.1:${String(OPENCODE_PORT)}`,
};

export { repoRoot };
