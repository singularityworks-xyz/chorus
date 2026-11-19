import { describe, expect, test } from "bun:test";
import {
  getEarlierStreamContentRange,
  getLatestStreamContentRange,
  STREAM_CONTENT_PAGE_CHARS,
} from "./stream-content-page";

describe("stream content pages", () => {
  test("shows a bounded latest page aligned to a nearby paragraph", () => {
    const content = Array.from(
      { length: 1000 },
      (_, index) => `Paragraph ${index}: ${"reasoning ".repeat(12)}\n\n`
    ).join("");
    const latest = getLatestStreamContentRange(content);

    expect(latest.end).toBe(content.length);
    expect(latest.end - latest.start).toBeLessThanOrEqual(
      STREAM_CONTENT_PAGE_CHARS
    );
    expect(content.slice(latest.start, latest.end)).toContain("Paragraph 999:");
    expect(content.slice(0, latest.start).endsWith("\n\n")).toBe(true);
  });

  test("pages backward without gaps or duplicated transcript text", () => {
    const content = Array.from(
      { length: 6000 },
      (_, index) => `Paragraph ${index}: stable transcript content.\n\n`
    ).join("");
    const pages = [getLatestStreamContentRange(content)];

    while (pages.at(-1)?.start !== 0) {
      const current = pages.at(-1);
      if (!current) {
        throw new Error("expected a transcript page");
      }
      const earlier = getEarlierStreamContentRange(content, current);
      if (!earlier) {
        throw new Error("expected an earlier transcript page");
      }
      expect(earlier.end).toBe(current.start);
      expect(earlier.end - earlier.start).toBeLessThanOrEqual(
        STREAM_CONTENT_PAGE_CHARS
      );
      pages.push(earlier);
    }

    const orderedPages = pages.reverse();
    expect(orderedPages[0]?.start).toBe(0);
    for (let index = 1; index < orderedPages.length; index += 1) {
      expect(orderedPages[index - 1]?.end).toBe(orderedPages[index]?.start);
    }
    expect(
      orderedPages.map(({ start, end }) => content.slice(start, end)).join("")
    ).toBe(content);
  });

  test("keeps long paragraphs and empty content reachable", () => {
    const longParagraph = "x".repeat(STREAM_CONTENT_PAGE_CHARS * 3 + 7);
    let range = getLatestStreamContentRange(longParagraph);
    const pages = [range];

    while (range.start > 0) {
      const earlier = getEarlierStreamContentRange(longParagraph, range);
      if (!earlier) {
        throw new Error("expected an earlier transcript page");
      }
      pages.push(earlier);
      range = earlier;
    }

    expect(
      pages
        .reverse()
        .map(({ start, end }) => longParagraph.slice(start, end))
        .join("")
    ).toBe(longParagraph);
    expect(getLatestStreamContentRange("")).toEqual({ start: 0, end: 0 });
    expect(
      getEarlierStreamContentRange("", { start: 0, end: 0 })
    ).toBeUndefined();
  });
});
