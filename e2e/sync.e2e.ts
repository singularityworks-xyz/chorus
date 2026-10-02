import type { Page, WebSocket } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Client sync e2e (plan P5 integration list).
 *
 * These are the behaviours that only a real browser can prove. A jsdom test with
 * a mocked socket would pass for every one of them, because the things being
 * tested are the browser's own: `localStorage` surviving a reload,
 * `visibilitychange` and `online` firing, a socket that actually dies, and the
 * app's own 4401 handling.
 */

const TOKEN =
  process.env.CHORUS_E2E_TOKEN ??
  "e2e00000000000000000000000000000000000000000000000000000000000000";

/**
 * Signs in through the real login screen.
 *
 * Deliberately the UI path rather than a cookie injection: the exchange is the
 * thing under test in one of the cases, and a hand-set cookie would skip it.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Access token").fill(TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("/");
}

/**
 * Creates a board from inside the page.
 *
 * Goes through the app's own proxy rather than straight to serve, because serve
 * requires the session cookie and the only place it exists is the browser. This
 * also exercises the proxy path the app actually uses.
 */
// biome-ignore lint/suspicious/useAwait: forwards the page's awaited evaluate result
async function createBoard(page: Page, title: string): Promise<string> {
  return page.evaluate(async (boardTitle) => {
    const response = await fetch("/api/workspace", {
      body: JSON.stringify({
        baseRevision: null,
        clientId: "playwright",
        mutationId: `pw-${crypto.randomUUID()}`,
        payload: {
          seed: {
            repo: {
              directory: "/tmp/chorus-e2e-repo",
              sandboxes: [],
              worktree: "/tmp/chorus-e2e-repo",
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
  }, title);
}

/**
 * Asserts the board reached the client.
 *
 * Uses the `data-board-title` hook and `toBeAttached`, not visible text: the
 * title appears in several nodes at once (canvas card, lane-list chip, recents
 * list), one of which lives in a collapsed container, and React Flow mounts and
 * lays out asynchronously. Visibility here measures layout, not state. The
 * phone-layout test is where rendering itself is asserted.
 */
function expectBoardPresent(page: Page, title: string) {
  return expect(
    page.locator(`[data-board-title="${title}"]`).first()
  ).toBeAttached({ timeout: 20_000 });
}

/**
 * A title unique to this run.
 *
 * Serve keeps its event log between spec runs, so a fixed title matches boards
 * from every previous run.
 */
function uniqueTitle(label: string): string {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

/** The cursor the client persisted for its next resume. */
function readLastSeq(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem("chorus:lastSeq"));
}

/** Waits for the socket to reach a live state, readable from the page. */
/**
 * Waits for a genuinely live client.
 *
 * Checking only that a snapshot was persisted at some point would also pass for a
 * client that connected, snapshotted, and then silently stalled -- which is
 * exactly the failure these tests exist to catch.
 */
async function waitForLive(page: Page): Promise<void> {
  await expect
    .poll(() => readLastSeq(page), { timeout: 30_000 })
    .not.toBeNull();
  await expect(page.getByTestId("connection-strip")).toHaveCount(0, {
    timeout: 30_000,
  });
}

test.describe("client sync", () => {
  test("a hard refresh resumes from the persisted cursor", async ({ page }) => {
    await signIn(page);
    await waitForLive(page);
    const title = uniqueTitle("E2E resume board");
    await createBoard(page, title);
    await expectBoardPresent(page, title);

    // Two reloads, on purpose.
    //
    // The persisted cursor is pinned to the last full snapshot, and live events
    // deliberately do not move it: a cursor only means something next to the
    // state it refers to, and persisting one without the matching snapshot would
    // leave a reload resuming from a hole with nothing on screen. So the first
    // reload is what establishes a cursor at the server's current head; the
    // second is the one that can prove the cursor is actually *reused* instead
    // of the client always asking for `since: 0`.
    await page.reload();
    await expectBoardPresent(page, title);
    await expect
      .poll(() => readLastSeq(page), { timeout: 30_000 })
      .not.toBeNull();

    const cursor = await readLastSeq(page);
    expect(Number(cursor)).toBeGreaterThan(0);

    // Captured from the socket itself, not inferred from the UI.
    const helloFrames: unknown[] = [];
    page.on("websocket", (socket: WebSocket) => {
      socket.on("framesent", (event: { payload: string }) => {
        const parsed = JSON.parse(event.payload) as { type?: string };
        if (parsed.type === "hello") {
          helloFrames.push(parsed);
        }
      });
    });

    // Only a handshake sent *after* the reload counts. The listener is attached
    // early enough to catch the upgrade itself, so it also records the
    // pre-reload hello; comparing counts pins the right frame instead of racing
    // whatever happens to be last.
    const hellosBeforeReload = helloFrames.length;
    await page.reload();

    // Asserted, not merely collected. Without this the test would pass even if
    // the client always said `since: 0` and took a full snapshot every load --
    // which is the behaviour this phase exists to remove.
    await expect
      .poll(() => helloFrames.length, { timeout: 20_000 })
      .toBeGreaterThan(hellosBeforeReload);

    const resumed = helloFrames.at(-1) as { since: number; type: string };
    expect(resumed.type).toBe("hello");
    expect(Number(resumed.since)).toBe(Number(cursor));

    // And the workspace came back, not just the handshake.
    await expectBoardPresent(page, title);
  });

  test("the app hydrates state over the socket and renders boards", async ({
    page,
  }) => {
    await signIn(page);
    const title = uniqueTitle("E2E visible board");
    await createBoard(page, title);

    // State arrives as patches over the socket; nothing polls for it.
    await expectBoardPresent(page, title);
  });

  test("a dropped socket reconnects and keeps the client live", async ({
    page,
  }) => {
    await signIn(page);
    const title = uniqueTitle("E2E reconnect board");
    await createBoard(page, title);
    await expectBoardPresent(page, title);

    // Simulate the radio dropping by failing every request for a window.
    await page.context().setOffline(true);
    await page.waitForTimeout(1000);
    await page.context().setOffline(false);

    // Coming back online triggers an immediate reconnect, which is the
    // `visibilitychange`/`online` path the plan requires to be idempotent.
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect
      .poll(() => readLastSeq(page), { timeout: 30_000 })
      .not.toBeNull();

    // And the board is still there afterwards: reconnecting must not lose state.
    await expectBoardPresent(page, title);
  });

  test("a dead session stops reconnecting and shows the login gate", async ({
    browser,
    page,
  }) => {
    await signIn(page);
    await waitForLive(page);

    // Drop the session cookie out from under the page. The next socket upgrade
    // carries no credential, the hub answers 4401, and the client must stop
    // rather than reconnect forever.
    await page.context().clearCookies();

    await page.reload();

    await expect(page.getByText("Session expired")).toBeVisible({
      timeout: 30_000,
    });

    // The gate is a state, not a redirect: the URL is unchanged and there is no
    // loop, so a dead session cannot bounce the browser between routes.
    expect(new URL(page.url()).pathname).toBe("/");

    // Signing back in clears the gate without a manual reload.
    await page.getByRole("link", { name: "Sign in" }).click();
    await page.waitForURL("/login");
    await page.getByLabel("Access token").fill(TOKEN);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL("/");
    await expect(page.getByText("Session expired")).toHaveCount(0, {
      timeout: 30_000,
    });
    expect(browser).toBeDefined();
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

    // The layout swap itself: the lane list owns the viewport and the canvas is
    // display-none, rather than both being mounted and competing.
    await expect(page.getByTestId("mobile-lane-list")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("desktop-canvas")).toBeHidden();

    // And the lane list really renders the board, not just the container.
    await expect(
      page
        .getByTestId("mobile-lane-list")
        .getByText(title)
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 20_000 });
  });
});
