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
          clientId: "playwright-autocomplete",
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

test.describe("board autocomplete", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("shows provider failures and retries suggestions without losing the query", async ({
    page,
  }) => {
    const boardTitle = `E2E autocomplete ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, boardTitle);
    await selectBoard(page, boardTitle);

    let attempts = 0;
    await page.route(
      (url) =>
        url.pathname.includes("/api/boards/") &&
        url.pathname.endsWith("/autocomplete"),
      async (route) => {
        attempts += 1;
        if (attempts === 1) {
          await route.fulfill({
            body: JSON.stringify({
              code: "autocomplete_unavailable",
              message:
                "Could not load board suggestions. Check the provider connection and retry.",
            }),
            contentType: "application/json",
            status: 502,
          });
          return;
        }
        await route.fulfill({
          body: JSON.stringify({ kind: "files", files: ["src/main.ts"] }),
          contentType: "application/json",
          status: 200,
        });
      }
    );

    const composer = page.getByRole("textbox", { name: "Prompt Chorus" });
    await composer.fill("@main");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Check the provider connection and retry." })
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(
      page.getByRole("option").filter({ hasText: "main.ts" })
    ).toBeVisible();
    await expect(composer).toHaveValue("@main");
    expect(attempts).toBe(2);
  });
});
