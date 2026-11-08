import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffNotice } from "./diff-notice";

describe("DiffNotice", () => {
  test("shows an error with a reachable retry control", () => {
    const markup = renderToStaticMarkup(
      <DiffNotice
        error="Could not reach Chorus to load session diffs. Retry."
        notice={null}
        onRetry={() => undefined}
        retrying={false}
      />
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not reach Chorus");
    expect(markup).toContain('aria-label="Retry loading session diffs"');
    expect(markup).toContain(">Retry</button>");
  });

  test("announces an empty result as a status without an error action", () => {
    const markup = renderToStaticMarkup(
      <DiffNotice
        error={null}
        notice="No file changes are available for this session."
        onRetry={() => undefined}
        retrying={false}
      />
    );

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("Retry loading session diffs");
  });

  test("disables retry while the next request is pending", () => {
    const markup = renderToStaticMarkup(
      <DiffNotice
        error="Diff loading failed."
        notice={null}
        onRetry={() => undefined}
        retrying
      />
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Retrying…");
  });
});
