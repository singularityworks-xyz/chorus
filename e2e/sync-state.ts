import { expect, type Page } from "@playwright/test";

const PERSISTED_SNAPSHOT_KEY = "chorus:snapshot";

export function readPersistedSequence(page: Page): Promise<number | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("seq" in parsed) ||
        typeof parsed.seq !== "number" ||
        !Number.isSafeInteger(parsed.seq)
      ) {
        return null;
      }

      return parsed.seq;
    } catch {
      return null;
    }
  }, PERSISTED_SNAPSHOT_KEY);
}

export async function waitForSyncLive(page: Page): Promise<void> {
  await expect
    .poll(() => readPersistedSequence(page), { timeout: 30_000 })
    .not.toBeNull();
  await expect(page.getByTestId("connection-strip")).toHaveCount(0, {
    timeout: 30_000,
  });
}
