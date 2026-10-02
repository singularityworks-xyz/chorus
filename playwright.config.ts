import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration (plan P5, first Playwright config in the repo).
 *
 * The suite drives a real browser against a real serve process, because the
 * behaviours it exists to prove are exactly the ones a jsdom test fakes:
 *
 * - `localStorage` survives a reload and is read on the next connect.
 * - `visibilitychange` and `online` fire in a real browser.
 * - A WebSocket that dies mid-session reconnects on its own.
 * - A 4401 close stops the reconnect loop rather than looping forever.
 *
 * `webServer` boots serve with a pinned token and a throwaway data dir, and
 * leaves the browser pointing at it. Next.js runs in dev mode so the spec does
 * not depend on a production build having been produced first; the release gate
 * is the unit and integration suites plus this spec, and the Docker image runs
 * the built output.
 */
const SERVE_PORT = Number(process.env.CHORUS_E2E_SERVE_PORT ?? 2199);
const WEB_PORT = Number(process.env.CHORUS_E2E_WEB_PORT ?? 3199);
const TOKEN =
  "e2e00000000000000000000000000000000000000000000000000000000000000";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  // Scoped deliberately. Playwright loads test files with Node's ESM loader, so
  // a root-level glob would try to execute the repo's `bun:test` suites and fail
  // on `bun:` imports and `bun:test`.
  testDir: "./e2e",
  // `.e2e.ts` rather than `.spec.ts`: `bun test` globs `*.spec.ts` too, and
  // loading a Playwright suite under `bun:test` fails on `test.describe`.
  // Distinct extension means each runner owns its own files.
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  // The restart and offline cases own a shared serve process, so they must not
  // interleave.
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      // The phone layout is the spec §9 deliverable, and the lane list replaces
      // the canvas below `md`, so the mobile project is not redundant.
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      command: `OPENCODE_AUTO_START=false NODE_ENV=production CHORUS_TOKEN=${TOKEN} PORT=${SERVE_PORT} DATA_DIR=${process.env.CHORUS_E2E_DATA_DIR ?? "/tmp/chorus-e2e"} bun run apps/serve/src/index.ts`,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      timeout: 60_000,
      url: `http://127.0.0.1:${SERVE_PORT}/health`,
    },
    {
      // The production build, not `next dev`.
      //
      // Dev-mode hydration does not attach handlers in this app — a controlled
      // input and a plain `onClick` both stay inert under `next dev` with
      // Turbopack, while the built output behaves correctly. A spec that cannot
      // drive the UI is not worth running, and the release gate should exercise
      // the output that actually ships.
      command: `bun run --cwd apps/web build && bun run --cwd apps/web start --port ${WEB_PORT}`,
      env: {
        CHORUS_SERVE_URL: `http://127.0.0.1:${SERVE_PORT}`,
        NEXT_PUBLIC_CHORUS_WS_URL: `ws://127.0.0.1:${SERVE_PORT}/ws`,
      },
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      timeout: 600_000,
      url: `http://127.0.0.1:${WEB_PORT}/login`,
    },
  ],
});

export { SERVE_PORT, TOKEN, WEB_PORT };
