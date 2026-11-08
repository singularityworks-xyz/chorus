import { describe, expect, test } from "bun:test";
import { copyTextToClipboard } from "./copy-text-to-clipboard";

describe("copyTextToClipboard", () => {
  test("writes the provided text to the clipboard", async () => {
    const written: string[] = [];

    await copyTextToClipboard("agent response", {
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });

    expect(written).toEqual(["agent response"]);
  });

  test("surfaces unavailable clipboard access", async () => {
    await expect(
      copyTextToClipboard("agent response", undefined)
    ).rejects.toThrow("Clipboard access is unavailable.");
  });

  test("propagates a failed clipboard write", async () => {
    await expect(
      copyTextToClipboard("agent response", {
        writeText: () => Promise.reject(new Error("permission denied")),
      })
    ).rejects.toThrow("permission denied");
  });
});
