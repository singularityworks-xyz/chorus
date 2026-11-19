import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { E2E_REPO_DIR } from "./serve-env";
import { signIn, test } from "./workspace-fixture";

const HAS_PROVIDER = process.env.CHORUS_E2E_AGENT === "1";

async function createBoard(page: Page, title: string): Promise<string> {
  await page.evaluate(
    async ({ boardTitle, directory }) => {
      const response = await fetch("/api/workspace", {
        body: JSON.stringify({
          baseRevision: null,
          clientId: "playwright",
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

  return title;
}

async function selectBoard(page: Page, title: string): Promise<void> {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: title }).click();
  await expect(page.getByRole("combobox")).toContainText(title);
}

async function submitPrompt(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Prompt Chorus" });
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

test.describe("agent lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await expect
      .poll(
        () =>
          page.evaluate(() => window.localStorage.getItem("chorus:lastSeq")),
        {
          timeout: 30_000,
        }
      )
      .not.toBeNull();
  });

  test("a submitted prompt reaches the engine and requests approval", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "agent lifecycle is server-side; covered by the desktop project"
    );

    const board = `E2E agent ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, board);

    if (!HAS_PROVIDER) {
      const response = await page.request.post("/api/workspace", {
        headers: { origin: new URL(page.url()).origin },
        data: {
          baseRevision: null,
          clientId: "playwright",
          mutationId: crypto.randomUUID(),
          type: "preference.default_model.set",
          payload: { model: { providerID: "fixture", modelID: "scripted" } },
        },
      });
      expect(response.ok()).toBe(true);
    }
    const prompt = "Summarise the README in one sentence.";
    await selectBoard(page, board);
    await submitPrompt(page, prompt);
    await page.getByRole("button", { name: "Fit view" }).click();
    await expect(
      page.getByText(prompt).filter({ visible: true }).first()
    ).toBeVisible();
    if (!HAS_PROVIDER) {
      const approve = page.getByRole("button", {
        name: "Approve",
        exact: true,
      });
      await approve.click();
      await expect(approve).toHaveCount(0);
      await expect(
        page.getByText("Thinking", { exact: true }).first()
      ).toBeVisible();
    }
  });

  test("a prompt runs to completion and the agent changes the repository", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "agent lifecycle is server-side; covered by the desktop project"
    );

    test.skip(
      !HAS_PROVIDER,
      "needs a configured model provider; set CHORUS_E2E_AGENT=1"
    );

    const board = `E2E agent run ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, board);

    await selectBoard(page, board);

    await submitPrompt(
      page,
      "Write the word CHORUS into proof.txt and then stop."
    );

    await expect
      .poll(
        () =>
          page.evaluate(async (boardTitle) => {
            const response = await fetch("/api/workspace");
            const snapshot = (await response.json()) as {
              boards?: {
                columns: Record<string, { title: string }[]>;
                title: string;
              }[];
            };
            return (
              snapshot.boards?.find((entry) => entry.title === boardTitle)
                ?.columns.done ?? []
            ).length;
          }, board),
        { timeout: 180_000 }
      )
      .toBeGreaterThan(0);

    const proofPath = join(E2E_REPO_DIR, "proof.txt");
    await expect
      .poll(
        () => (existsSync(proofPath) ? readFileSync(proofPath, "utf8") : ""),
        {
          timeout: 60_000,
        }
      )
      .toContain("CHORUS");
  });
});
