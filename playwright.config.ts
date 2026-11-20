import { defineConfig, devices } from "@playwright/test";
import { SERVE_PORT, WEB_PORT } from "./e2e/serve-env";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),

  testDir: "./e2e",

  testMatch: "**/*.e2e.ts",
  fullyParallel: false,

  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    baseURL: `http://127.0.0.1:${WEB_PORT}`,

    channel: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: "mobile",

      testIgnore: [
        "**/agent.e2e.ts",
        "**/canvas-controls.e2e.ts",
        "**/session-history.e2e.ts",
      ],
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      command:
        "bun run --cwd apps/web build && node apps/web/.next/standalone/apps/web/server.js",
      env: {
        HOSTNAME: "127.0.0.1",
        PORT: String(WEB_PORT),
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
