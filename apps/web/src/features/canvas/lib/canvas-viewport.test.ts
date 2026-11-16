import { describe, expect, test } from "bun:test";
import { hasCanvasViewport } from "./canvas-viewport";

describe("hasCanvasViewport", () => {
  test("waits for a finite, nonzero measured viewport", () => {
    expect(hasCanvasViewport(0, 0)).toBe(false);
    expect(hasCanvasViewport(390, 0)).toBe(false);
    expect(hasCanvasViewport(0, 844)).toBe(false);
    expect(hasCanvasViewport(Number.NaN, 844)).toBe(false);
    expect(hasCanvasViewport(390, Number.POSITIVE_INFINITY)).toBe(false);
    expect(hasCanvasViewport(390, 844)).toBe(true);
  });
});
