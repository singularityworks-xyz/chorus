import { describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardSessionHistoryActions } from "./board-session-history-controls";

function renderHistoryActions(
  overrides: Partial<ComponentProps<typeof BoardSessionHistoryActions>> = {}
) {
  return renderToStaticMarkup(
    <BoardSessionHistoryActions
      boardBusy={false}
      canRedo={false}
      canUndo={false}
      error={null}
      isLoading={false}
      onRefresh={() => undefined}
      onRunCommand={() => undefined}
      pendingCommand={null}
      {...overrides}
    />
  );
}

function buttonMarkup(markup: string, label: string): string {
  const button = markup.match(
    new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`)
  )?.[0];
  if (!button) {
    throw new Error(`Could not find ${label} button in rendered output.`);
  }
  return button;
}

describe("repository history controls", () => {
  test("enables Undo and Redo only when the history allows them", () => {
    const markup = renderHistoryActions({ canRedo: true, canUndo: true });

    expect(buttonMarkup(markup, "Undo repository changes")).not.toContain(
      "disabled"
    );
    expect(buttonMarkup(markup, "Redo repository changes")).not.toContain(
      "disabled"
    );
  });

  test("disables both controls while the board is busy and explains why", () => {
    const markup = renderHistoryActions({
      boardBusy: true,
      canRedo: true,
      canUndo: true,
    });

    expect(buttonMarkup(markup, "Undo repository changes")).toContain(
      "disabled"
    );
    expect(buttonMarkup(markup, "Redo repository changes")).toContain(
      "disabled"
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      "Finish current work or review before changing repository history."
    );
  });

  test("keeps a pending history command disabled with a specific label", () => {
    const markup = renderHistoryActions({
      canRedo: true,
      canUndo: true,
      pendingCommand: "undo",
    });

    expect(buttonMarkup(markup, "Undo repository changes")).toContain(
      'title="Undoing repository changes"'
    );
    expect(buttonMarkup(markup, "Undo repository changes")).toContain(
      "disabled"
    );
    expect(buttonMarkup(markup, "Redo repository changes")).toContain(
      "disabled"
    );
  });

  test("shows a retryable error without claiming history changed", () => {
    const markup = renderHistoryActions({
      canUndo: true,
      error:
        "Could not confirm Undo. Check repository history before retrying.",
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not confirm Undo.");
    expect(markup).toContain(">Retry</button>");
    expect(markup).not.toContain('role="status"');
  });

  test("keeps history controls disabled while availability is loading", () => {
    const markup = renderHistoryActions({
      canRedo: true,
      canUndo: true,
      isLoading: true,
    });

    expect(buttonMarkup(markup, "Undo repository changes")).toContain(
      "disabled"
    );
    expect(buttonMarkup(markup, "Redo repository changes")).toContain(
      "disabled"
    );
  });
});
