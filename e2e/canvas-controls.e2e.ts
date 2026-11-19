import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { E2E_REPO_DIR } from "./serve-env";
import { signIn, test } from "./workspace-fixture";

async function createBoard(page: Page, title: string): Promise<void> {
  await page.evaluate(
    async ({ boardTitle, directory }) => {
      const response = await fetch("/api/workspace", {
        body: JSON.stringify({
          baseRevision: null,
          clientId: "playwright-canvas-controls",
          mutationId: `pw-${crypto.randomUUID()}`,
          payload: {
            seed: {
              repo: { directory, sandboxes: [], worktree: directory },
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
    },
    { boardTitle: title, directory: E2E_REPO_DIR }
  );
}

async function selectBoard(page: Page, title: string): Promise<void> {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: title }).click();
  await expect(page.getByRole("combobox")).toContainText(title);
}

test.describe("desktop canvas controls", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("N focuses the selected board's composer", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "the mobile layout does not expose the canvas keyboard shortcuts"
    );
    const boardTitle = `E2E canvas new task ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, boardTitle);
    await selectBoard(page, boardTitle);

    await page.keyboard.press("n");

    await expect(
      page.getByRole("textbox", { name: "Prompt Chorus" })
    ).toBeFocused();
  });

  test("keeps a board visible and explains a rejected removal", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "the mobile layout does not expose canvas board removal controls"
    );
    const boardTitle = `E2E canvas removal ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, boardTitle);
    await selectBoard(page, boardTitle);

    await page.route("**/api/workspace", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      const payload: unknown = route.request().postDataJSON();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("type" in payload) ||
        payload.type !== "board.remove"
      ) {
        await route.continue();
        return;
      }

      await route.fulfill({
        body: JSON.stringify({
          code: "board_busy",
          message: "Wait for active work to finish before removing this board.",
        }),
        contentType: "application/json",
        status: 409,
      });
    });

    await page.getByRole("button", { name: "Fit view" }).click();
    await page
      .getByRole("button", { name: `Remove ${boardTitle} board` })
      .click();

    await expect(
      page.getByRole("alert").filter({ hasText: "It remains open; try again." })
    ).toBeVisible();
    await expect(
      page.locator(`[data-board-title="${boardTitle}"]`)
    ).toBeAttached();
    await expect(
      page.getByRole("button", { name: `Remove ${boardTitle} board` })
    ).toBeEnabled();
  });
});
