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
          clientId: "playwright-review-mode",
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
  if (test.info().project.name === "mobile") {
    const boardChip = page.locator(`button[data-board-title="${title}"]`);
    if ((await boardChip.count()) > 0) {
      await boardChip.click();
    }
    await expect(
      page.locator(`[data-board-title="${title}"]`).first()
    ).toBeAttached();
    return;
  }

  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: title }).click();
  await page.getByRole("button", { name: "Fit view" }).click();
}

test.describe("review mode control", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("restores the saved mode and explains a rejected update", async ({
    page,
  }) => {
    const boardTitle = `E2E review mode ${crypto.randomUUID().slice(0, 8)}`;
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
        payload.type !== "board.review_mode.set"
      ) {
        await route.continue();
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        body: JSON.stringify({
          code: "workspace_unavailable",
          message: "Could not save review settings.",
        }),
        contentType: "application/json",
        status: 503,
      });
    });

    const reviewModeButton = page.getByRole("button", {
      name: "Auto review mode",
    });
    await reviewModeButton.scrollIntoViewIfNeeded();
    await reviewModeButton.click();

    const saveButton = page.getByRole("button", { name: "Saving review mode" });
    await expect(saveButton).toBeDisabled();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Your previous setting was restored" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Auto review mode" })
    ).toBeEnabled();
  });
});
