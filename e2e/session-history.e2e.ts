import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { E2E_REPO_DIR, TOKEN } from "./serve-env";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Access token").fill(TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("/");
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("chorus:lastSeq"))
    )
    .not.toBeNull();
}

async function createBoard(page: Page, title: string): Promise<void> {
  await page.evaluate(
    async ({ boardTitle, directory }) => {
      const response = await fetch("/api/workspace", {
        body: JSON.stringify({
          baseRevision: null,
          clientId: "playwright-session-history",
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

function workspaceBoardColumns(page: Page, title: string) {
  return page.evaluate(async (boardTitle) => {
    const response = await fetch("/api/workspace");
    if (!response.ok) {
      return null;
    }
    const snapshot = (await response.json()) as {
      boards?: { columns: Record<string, unknown>; title: string }[];
    };
    const board = snapshot.boards?.find((entry) => entry.title === boardTitle);
    return board ? JSON.stringify(board.columns) : null;
  }, title);
}

test.describe("board repository history controls", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("Undo and Redo buttons follow the board session state", async ({
    page,
  }) => {
    let canUndo = true;
    let canRedo = false;
    const commands: string[] = [];

    await page.route("**/api/boards/*/session/history", async (route) => {
      const boardId = new URL(route.request().url()).pathname.split("/")[3];
      await route.fulfill({
        body: JSON.stringify({
          boardId,
          canRedo,
          canUndo,
          busy: false,
          sessionId: null,
          timestamp: Date.now(),
        }),
        contentType: "application/json",
      });
    });
    await page.route("**/api/boards/*/session/history/undo", async (route) => {
      const boardId = new URL(route.request().url()).pathname.split("/")[3];
      commands.push("undo");
      canUndo = false;
      canRedo = true;
      await route.fulfill({
        body: JSON.stringify({
          accepted: true,
          boardId,
          command: "undo",
          sessionId: "mock-session",
          timestamp: Date.now(),
        }),
        contentType: "application/json",
      });
    });
    await page.route("**/api/boards/*/session/history/redo", async (route) => {
      const boardId = new URL(route.request().url()).pathname.split("/")[3];
      commands.push("redo");
      canUndo = true;
      canRedo = false;
      await route.fulfill({
        body: JSON.stringify({
          accepted: true,
          boardId,
          command: "redo",
          sessionId: "mock-session",
          timestamp: Date.now(),
        }),
        contentType: "application/json",
      });
    });

    const boardTitle = `E2E history ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, boardTitle);
    await selectBoard(page, boardTitle);
    const undoButton = page.getByRole("button", {
      name: "Undo repository changes",
    });
    const redoButton = page.getByRole("button", {
      name: "Redo repository changes",
    });
    await expect(undoButton).toBeEnabled();
    const columnsBefore = await workspaceBoardColumns(page, boardTitle);

    await undoButton.click();
    await expect(redoButton).toBeEnabled();
    await expect(undoButton).toBeDisabled();
    await redoButton.click();

    await expect(undoButton).toBeEnabled();
    await expect(redoButton).toBeDisabled();
    const composer = page.getByRole("textbox", { name: "Prompt Chorus" });
    await composer.fill("/undo");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(redoButton).toBeEnabled();
    expect(commands).toEqual(["undo", "redo", "undo"]);
    expect(await workspaceBoardColumns(page, boardTitle)).toBe(columnsBefore);
  });

  test("a rejected history change shows an error and refreshes safely", async ({
    page,
  }) => {
    let busy = false;
    let failedFirstUndo = false;
    let canUndo = true;
    let canRedo = false;

    await page.route("**/api/boards/*/session/history", async (route) => {
      const boardId = new URL(route.request().url()).pathname.split("/")[3];
      await route.fulfill({
        body: JSON.stringify({
          boardId,
          canRedo,
          canUndo: busy ? false : canUndo,
          busy,
          sessionId: null,
          timestamp: Date.now(),
        }),
        contentType: "application/json",
      });
    });
    await page.route("**/api/boards/*/session/history/undo", async (route) => {
      const boardId = new URL(route.request().url()).pathname.split("/")[3];
      if (!failedFirstUndo) {
        failedFirstUndo = true;
        busy = true;
        await route.fulfill({
          body: JSON.stringify({
            code: "session_busy",
            message: "Wait for the board's current work to finish.",
          }),
          contentType: "application/json",
          status: 409,
        });
        return;
      }

      canUndo = false;
      canRedo = true;
      await route.fulfill({
        body: JSON.stringify({
          accepted: true,
          boardId,
          command: "undo",
          sessionId: "mock-session",
          timestamp: Date.now(),
        }),
        contentType: "application/json",
      });
    });

    const boardTitle = `E2E history error ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, boardTitle);
    await selectBoard(page, boardTitle);
    const undoButton = page.getByRole("button", {
      name: "Undo repository changes",
    });
    await expect(undoButton).toBeEnabled();

    await undoButton.click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(
      "Wait for the board's current work to finish."
    );
    await expect(undoButton).toBeDisabled();

    busy = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(alert).toHaveCount(0);
    await expect(undoButton).toBeEnabled();
    await undoButton.click();
    await expect(
      page.getByRole("button", { name: "Redo repository changes" })
    ).toBeEnabled();
  });
});
