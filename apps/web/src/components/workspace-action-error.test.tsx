import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceActionError } from "./workspace-action-error";

test("workspace action failures are announced and can be dismissed", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceActionError
      message="Could not open a repository folder. Check the connection and try again."
      onDismiss={() => undefined}
    />
  );

  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Could not open a repository folder");
  expect(markup).toContain('aria-label="Dismiss workspace action error"');
  expect(markup).toContain(">Dismiss</button>");
});
