import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitStatusFeedback } from "./git-status-feedback";

test("repository status loading is announced", () => {
  const markup = renderToStaticMarkup(
    <GitStatusFeedback error={null} loading onRetry={() => undefined} />
  );

  expect(markup).toContain('role="status"');
  expect(markup).toContain("Checking status…");
});

test("repository status errors explain the state and expose retry", () => {
  const markup = renderToStaticMarkup(
    <GitStatusFeedback
      error="The repository is unavailable. Retry."
      loading={false}
      onRetry={() => undefined}
    />
  );

  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Status unavailable");
  expect(markup).toContain("The repository is unavailable. Retry.");
  expect(markup).toContain('aria-label="Retry repository status"');
  expect(markup).toContain(">Retry</button>");
});
