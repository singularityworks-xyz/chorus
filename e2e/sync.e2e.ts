import type { Page, WebSocket } from "@playwright/test";
import { expect } from "@playwright/test";

import {
  E2E_REPO_DIR,
  E2E_SERVE_ENV,
  repoRoot,
  SERVE_DATA_DIR,
  SERVE_LOG_FILE,
  SERVE_PID_FILE,
  SERVE_PORT,
  TOKEN,
} from "./serve-env";
import { start, stop } from "./serve-process";
import { readPersistedSequence, waitForSyncLive } from "./sync-state";
import { completeSignIn, signIn, test } from "./workspace-fixture";

// biome-ignore lint/suspicious/useAwait: forwards the page's awaited evaluate result
async function createBoard(page: Page, title: string): Promise<string> {
  return page.evaluate(
    async ({ boardTitle, directory }) => {
      const response = await fetch("/api/workspace", {
        body: JSON.stringify({
          baseRevision: null,
          clientId: "playwright",
          mutationId: `pw-${crypto.randomUUID()}`,
          payload: {
            seed: {
              repo: {
                directory,
                sandboxes: [],
                worktree: directory,
              },
              title: boardTitle,
            },
          },
          type: "board.create",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`board create failed: ${String(response.status)}`);
      }

      const snapshot = (await response.json()) as {
        boards: { boardId: string }[];
      };
      return snapshot.boards.at(-1)?.boardId ?? "";
    },
    { boardTitle: title, directory: E2E_REPO_DIR }
  );
}

function expectBoardPresent(page: Page, title: string) {
  return expect(
    page.locator(`[data-board-title="${title}"]`).first()
  ).toBeAttached({ timeout: 20_000 });
}

function uniqueTitle(label: string): string {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

test.describe("client sync", () => {
  test("a hard refresh resumes from the persisted cursor", async ({ page }) => {
    await signIn(page);
    await waitForSyncLive(page);
    const title = uniqueTitle("E2E resume board");
    await createBoard(page, title);
    await expectBoardPresent(page, title);

    await page.reload();
    await expectBoardPresent(page, title);
    await expect
      .poll(() => readPersistedSequence(page), { timeout: 30_000 })
      .not.toBeNull();

    const cursor = await readPersistedSequence(page);
    if (cursor === null) {
      throw new Error("The persisted workspace sequence is missing");
    }
    expect(cursor).toBeGreaterThan(0);

    const helloFrames: unknown[] = [];
    page.on("websocket", (socket: WebSocket) => {
      socket.on("framesent", (event: { payload: string }) => {
        const parsed = JSON.parse(event.payload) as { type?: string };
        if (parsed.type === "hello") {
          helloFrames.push(parsed);
        }
      });
    });

    const hellosBeforeReload = helloFrames.length;
    await page.reload();

    await expect
      .poll(() => helloFrames.length, { timeout: 20_000 })
      .toBeGreaterThan(hellosBeforeReload);

    const resumed = helloFrames.at(-1) as { since: number; type: string };
    expect(resumed.type).toBe("hello");
    expect(Number(resumed.since)).toBe(cursor);

    await expectBoardPresent(page, title);
  });

  test("the app hydrates state over the socket and renders boards", async ({
    page,
  }) => {
    await signIn(page);
    const title = uniqueTitle("E2E visible board");
    await createBoard(page, title);

    await expectBoardPresent(page, title);
  });

  test("a dropped socket reconnects and keeps the client live", async ({
    page,
  }) => {
    await signIn(page);
    const title = uniqueTitle("E2E reconnect board");
    await createBoard(page, title);
    await expectBoardPresent(page, title);

    await page.context().setOffline(true);
    await expect(page.getByTestId("connection-strip")).toBeVisible({
      timeout: 10_000,
    });
    await page.context().setOffline(false);

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByTestId("connection-strip")).toHaveCount(0, {
      timeout: 30_000,
    });

    await expectBoardPresent(page, title);
  });

  test("a restarted server is resumed from, not reloaded from scratch", async ({
    page,
  }) => {
    await signIn(page);
    await waitForSyncLive(page);
    const title = uniqueTitle("E2E restart board");
    await createBoard(page, title);
    await expectBoardPresent(page, title);

    await stop(SERVE_PORT, SERVE_PID_FILE);

    await expect(page.getByTestId("connection-strip")).toBeVisible({
      timeout: 20_000,
    });

    await start({
      dataDir: SERVE_DATA_DIR,
      env: E2E_SERVE_ENV,
      logFile: SERVE_LOG_FILE,
      pidFile: SERVE_PID_FILE,
      port: SERVE_PORT,
      repoRoot,
      token: TOKEN,
    });

    await expect(page.getByTestId("connection-strip")).toHaveCount(0, {
      timeout: 40_000,
    });
    await expectBoardPresent(page, title);
  });

  test("a change made while the client is offline arrives on reconnect", async ({
    browser,
    page,
  }) => {
    await signIn(page);
    await waitForSyncLive(page);
    const first = uniqueTitle("E2E offline first");
    await createBoard(page, first);
    await expectBoardPresent(page, first);

    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await signIn(other);
    await waitForSyncLive(other);
    const second = uniqueTitle("E2E offline second");
    await createBoard(other, second);

    await expectBoardPresent(page, second);

    await page.context().setOffline(true);
    await expect(page.getByTestId("connection-strip")).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(() => readPersistedSequence(page), { timeout: 20_000 })
      .not.toBeNull();

    const third = uniqueTitle("E2E offline third");
    await createBoard(other, third);

    await expect(page.locator(`[data-board-title="${third}"]`)).toHaveCount(0, {
      timeout: 5000,
    });

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByTestId("connection-strip")).toHaveCount(0, {
      timeout: 40_000,
    });
    await expectBoardPresent(page, third);

    await otherContext.close();
  });

  test("two browsers converge on the same workspace", async ({
    browser,
    page,
  }) => {
    await signIn(page);
    await waitForSyncLive(page);

    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await signIn(other);

    await waitForSyncLive(other);

    const fromFirst = uniqueTitle("E2E converge a");
    await createBoard(page, fromFirst);
    await expectBoardPresent(other, fromFirst);

    const fromSecond = uniqueTitle("E2E converge b");
    await createBoard(other, fromSecond);
    await expectBoardPresent(page, fromSecond);

    await expectBoardPresent(other, fromFirst);
    await expectBoardPresent(page, fromSecond);
    await expectBoardPresent(page, fromSecond);

    await otherContext.close();
  });

  test("a lost session redirects to sign-in and restores the requested page", async ({
    page,
  }) => {
    await signIn(page);
    await waitForSyncLive(page);
    const title = uniqueTitle("E2E sign-in recovery");
    await createBoard(page, title);
    await expectBoardPresent(page, title);
    await page.context().clearCookies();
    await page.reload();

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/");
    await expect(
      page.getByRole("heading", { name: "Connect to Chorus" })
    ).toBeVisible();

    await completeSignIn(page);
    await waitForSyncLive(page);
    await expectBoardPresent(page, title);
  });

  test("the phone layout replaces the canvas with a lane list", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "mobile",
      "the lane list only replaces the canvas below md"
    );

    await signIn(page);
    const title = uniqueTitle("E2E phone board");
    await createBoard(page, title);

    await expectBoardPresent(page, title);

    await expect(page.getByTestId("mobile-lane-list")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("desktop-canvas")).toBeHidden();

    await expect(
      page
        .getByTestId("mobile-lane-list")
        .getByText(title)
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 20_000 });

    const lanes = page.getByTestId("mobile-lanes").locator("> section");
    await expect(lanes).toHaveCount(4, { timeout: 20_000 });
    const widths = await lanes.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().width))
    );
    const heights = await lanes.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().height))
    );
    expect(Math.min(...widths)).toBeGreaterThan(280);

    const tops = await lanes.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().top))
    );
    expect(tops.every((top, i) => i === 0 || top >= (tops[i - 1] ?? 0))).toBe(
      true
    );
    expect(Math.max(...heights)).toBeGreaterThan(0);
  });
});
