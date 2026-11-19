import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerDock } from "./composer-dock";

describe("ComposerDock", () => {
  test("lets board controls receive clicks while interactive children stay active", () => {
    const markup = renderToStaticMarkup(
      <ComposerDock hint={<div className="pointer-events-none">Hint</div>}>
        <form className="pointer-events-auto">
          <textarea aria-label="Prompt Chorus" />
        </form>
        <div className="pointer-events-auto" data-testid="command-palette" />
      </ComposerDock>
    );

    expect(markup).toContain(
      'class="pointer-events-none fixed right-0 bottom-2 left-0 z-40 flex justify-center px-3 pb-[env(safe-area-inset-bottom)] md:bottom-8 md:px-4"'
    );
    expect(markup).toContain('class="pointer-events-none w-full max-w-3xl"');
    expect(markup.match(/class="pointer-events-auto"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Prompt Chorus"');
  });
});
