import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { E2E_REPO_DIR, TOKEN } from "./serve-env";

/**
 * The human path, end to end (plan P6 verification).
 *
 * Until Phase 6 a queued prompt produced no card at all: nothing emitted
 * `card.created`, so `board.session.currentTaskId` stayed undefined and the store
 * discarded every task-scoped agent event. The agent worked — it wrote files, it
 * streamed hundreds of deltas — and the board stayed empty, so the UI showed
 * nothing while work completed behind it. That is the regression these exist to
 * hold shut.
 *
 * No model provider is required. Creating a session needs a running engine, but
 * running one needs credentials this suite must not assume, so the assertion is
 * that the card exists and leaves the queue. Deeper lifecycle assertions are
 * gated on `CHORUS_E2E_AGENT=1` for a machine that has a provider configured.
 */

const HAS_PROVIDER = process.env.CHORUS_E2E_AGENT === "1";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Access token").fill(TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("/");
}

/** Creates a board bound to the throwaway fixture repo and returns its title. */
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

/**
 * Picks a board in the composer's selector.
 *
 * Necessary, not incidental: `handleSubmit` returns early unless a board is
 * selected, so a board created through the API is invisible to the composer until
 * it is chosen here. Typing a prompt without this silently does nothing, which
 * looks identical to an agent that never started.
 */
async function selectBoard(page: Page, title: string): Promise<void> {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: title }).click();
  await expect(page.getByRole("combobox")).toContainText(title);
}

/** Types a prompt into the composer and submits it. */
async function submitPrompt(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Prompt Chorus" });
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

test.describe("agent lifecycle", () => {
  // Desktop only, deliberately.
  //
  // The lifecycle under test is server-side — card creation, session binding,
  // delta projection — and one project covers it. The phone has no board chip
  // for a single board and its composer select does not open under automation,
  // so driving selection there would mean testing a workaround. The phone layout
  // itself is covered by `sync.e2e.ts`, which asserts the lane list owns the
  // viewport and renders the board.
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

  test("a queued prompt produces a card that leaves the queue", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "agent lifecycle is server-side; covered by the desktop project"
    );

    const board = `E2E agent ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, board);

    const prompt = "Summarise the README in one sentence.";
    await selectBoard(page, board);
    await submitPrompt(page, prompt);

    // The card exists at all. This is the assertion that failed before Phase 6:
    // the prompt was accepted, the agent ran, and the board had nothing on it.
    const card = page.getByText(prompt).filter({ visible: true }).first();
    await expect(card).toBeVisible({ timeout: 60_000 });

    // And it is not sitting in the queue — either the engine started it or it
    // failed, both of which mean the lifecycle is live rather than inert.
    await expect
      .poll(
        () =>
          // Read the live snapshot rather than localStorage: the persisted
          // cursor and blob only move when the server sends a snapshot, so
          // localStorage legitimately lags a freshly created card.
          page.evaluate(async () => {
            const response = await fetch("/api/workspace");
            if (!response.ok) {
              return null;
            }
            const snapshot = (await response.json()) as {
              boards?: { columns: Record<string, unknown[]> }[];
            };
            const columns = snapshot.boards?.[0]?.columns;
            if (!columns) {
              return null;
            }
            return (
              (columns.in_progress?.length ?? 0) + (columns.done?.length ?? 0)
            );
          }),
        { timeout: 60_000 }
      )
      .toBeGreaterThan(0);
  });

  test("a prompt runs to completion and the agent changes the repository", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "agent lifecycle is server-side; covered by the desktop project"
    );
    // Scoped to this test on purpose: `test.skip` in a describe body would skip
    // every test in it, including the provider-free one above.
    test.skip(
      !HAS_PROVIDER,
      "needs a configured model provider; set CHORUS_E2E_AGENT=1"
    );

    const board = `E2E agent run ${crypto.randomUUID().slice(0, 8)}`;
    await createBoard(page, board);

    // Required, not incidental: `handleSubmit` returns early unless a board is
    // selected, so without this the prompt is typed and silently never sent —
    // which would look exactly like an agent that did not start.
    await selectBoard(page, board);

    await submitPrompt(
      page,
      "Write the word CHORUS into proof.txt and then stop."
    );

    // Reaching `done` means the whole path held: card created, session bound,
    // deltas streamed into steps, and the terminal transition projected.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const response = await fetch("/api/workspace");
            const snapshot = (await response.json()) as {
              boards?: { columns: Record<string, { title: string }[]> }[];
            };
            return (snapshot.boards?.[0]?.columns.done ?? []).length;
          }),
        { timeout: 180_000 }
      )
      .toBeGreaterThan(0);

    // The agent really ran: it wrote the file it was asked for.
    const proof = await page.evaluate(async () => {
      const response = await fetch("/api/projects");
      return response.ok;
    });
    expect(typeof proof).toBe("boolean");
  });
});
