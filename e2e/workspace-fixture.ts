import { mkdirSync, rmSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";
import {
  E2E_SERVE_ENV,
  repoRoot,
  SERVE_DATA_DIR,
  SERVE_LOG_FILE,
  SERVE_PID_FILE,
  SERVE_PORT,
  TOKEN,
} from "./serve-env";
import { start, stop } from "./serve-process";

export const test = base.extend<{ isolatedWorkspace: undefined }>({
  isolatedWorkspace: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture argument destructuring.
    async ({}, use) => {
      await stop(SERVE_PORT, SERVE_PID_FILE);
      rmSync(SERVE_DATA_DIR, { force: true, recursive: true });
      mkdirSync(SERVE_DATA_DIR, { recursive: true });
      try {
        await start({
          dataDir: SERVE_DATA_DIR,
          env: E2E_SERVE_ENV,
          logFile: SERVE_LOG_FILE,
          pidFile: SERVE_PID_FILE,
          port: SERVE_PORT,
          repoRoot,
          token: TOKEN,
        });
        await use(undefined);
      } finally {
        await stop(SERVE_PORT, SERVE_PID_FILE);
      }
    },
    { auto: true },
  ],
});

export async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await completeSignIn(page);
}

export async function completeSignIn(page: Page): Promise<void> {
  await page.getByLabel("Device code or server access token").fill(TOKEN);
  const pending = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/login"
  );
  await page.getByRole("button", { name: "Continue" }).click();
  const response = await pending;
  expect(response.ok(), `Login returned HTTP ${response.status()}`).toBe(true);
  await page.waitForURL("/");
}
