import { describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileMenuDrawer } from "./mobile-menu-drawer";

type Props = ComponentProps<typeof MobileMenuDrawer>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    boardViewMode: "stacked",
    createBoardFromHistory: () => undefined,
    createBoardFromProject: () => undefined,
    isLoadingRecentProjects: false,
    isOpeningFolder: false,
    loadProjects: async () => undefined,
    onClose: () => undefined,
    onOpenFolder: () => undefined,
    open: true,
    previousWorkspaces: [],
    recentProjects: [],
    recentProjectsError: null,
    recentProjectsLoaded: true,
    setBoardViewMode: () => undefined,
    ...overrides,
  };
}

describe("MobileMenuDrawer", () => {
  test("shows the workspace actions and only links to working menu destinations", () => {
    const markup = renderToStaticMarkup(<MobileMenuDrawer {...makeProps()} />);

    expect(markup).toContain("Open Folder…");
    expect(markup).toContain("Known Projects");
    expect(markup).toContain('href="/help"');
    expect(markup).not.toContain("Window");
    expect(markup).not.toContain("Edit");
  });

  test("renders nothing while closed", () => {
    const markup = renderToStaticMarkup(
      <MobileMenuDrawer {...makeProps({ open: false })} />
    );

    expect(markup).toBe("");
  });
});
