import { describe, expect, test } from "bun:test";
import { isNearLatestScrollPosition } from "./streamed-content-panel";

describe("stream scroll following", () => {
  test("keeps following when the reader is within the latest threshold", () => {
    expect(
      isNearLatestScrollPosition({
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 752,
      })
    ).toBe(true);
  });

  test("preserves the reader's position when they scroll back through output", () => {
    expect(
      isNearLatestScrollPosition({
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 700,
      })
    ).toBe(false);
  });

  test("treats content that fits in the viewport as already current", () => {
    expect(
      isNearLatestScrollPosition({
        clientHeight: 200,
        scrollHeight: 150,
        scrollTop: 0,
      })
    ).toBe(true);
  });
});
