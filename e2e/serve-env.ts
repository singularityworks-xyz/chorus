/**
 * Shared between `playwright.config.ts`, the global setup and the specs.
 *
 * These live in their own module because the config is loaded in Playwright's
 * own process while the specs and setup run in the test runner, and each needs
 * the same port, token and paths. Reading the environment separately in each
 * place is how a spec ends up pointed at a different server than the one the
 * run actually started.
 */

export const SERVE_PORT = Number(process.env.CHORUS_E2E_SERVE_PORT ?? 2199);
export const WEB_PORT = Number(process.env.CHORUS_E2E_WEB_PORT ?? 3199);
export const TOKEN =
  "e2e00000000000000000000000000000000000000000000000000000000000000";

// `process.cwd()` rather than `import.meta.dirname`: Playwright loads this file
// through its config loader as CommonJS, where `import.meta` is a syntax error.
// The config already assumes a repo-root working directory -- its `webServer`
// commands are repo-root relative -- so this assumes nothing new.
const repoRoot = process.cwd();

/**
 * A throwaway data dir, wiped on every run.
 *
 * Kept outside the workspace so a stray directory cannot end up committed, and
 * deliberately shared across a mid-test restart so the database survives -- the
 * client has to resume against a process that has forgotten the connection.
 */
export const SERVE_DATA_DIR =
  process.env.CHORUS_E2E_DATA_DIR ?? "/tmp/chorus-e2e";

export const SERVE_LOG_FILE = `${SERVE_DATA_DIR}/serve.log`;
export const SERVE_PID_FILE = `${SERVE_DATA_DIR}/serve.pid`;

export { repoRoot };
