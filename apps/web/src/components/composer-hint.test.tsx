import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerHint } from "./composer-hint";

describe("ComposerHint", () => {
  test("lets board controls receive clicks through the hint", () => {
    const markup = renderToStaticMarkup(
      <ComposerHint
        onDismiss={() => undefined}
        selectedBoardTitle="Run 7"
        sessionMessage="First prompt will start a new OpenCode session."
      />
    );

    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain("pointer-events-auto");
    expect(markup).toContain('aria-label="Dismiss composer hint"');
    expect(markup).toContain("Run 7 is selected.");
  });

  test("keeps the board-selection guidance when no board is selected", () => {
    const markup = renderToStaticMarkup(
      <ComposerHint onDismiss={() => undefined} sessionMessage="" />
    );

    expect(markup).toContain(
      "Open or select a board, then send the first prompt to start its OpenCode session."
    );
  });
});
