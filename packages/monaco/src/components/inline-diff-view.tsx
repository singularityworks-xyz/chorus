import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { useCallback, useRef } from "react";

const INLINE_DIFF_THEME = {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0d0d0d",
    "diffEditor.insertedTextBackground": "#2ea04333",
    "diffEditor.removedTextBackground": "#f8514933",
    "diffEditor.insertedLineBackground": "#2ea04322",
    "diffEditor.removedLineBackground": "#f8514922",
    "diffEditorGutter.insertedLineBackground": "#2ea04344",
    "diffEditorGutter.removedLineBackground": "#f8514944",
    "diffEditorOverview.insertedForeground": "#2ea04388",
    "diffEditorOverview.removedForeground": "#f8514988",
  },
} satisfies Parameters<Parameters<DiffOnMount>[1]["editor"]["defineTheme"]>[1];

interface InlineDiffViewProps {
  height?: string;
  language: string;
  modified: string;
  original: string;
}

export function InlineDiffView({
  height = "280px",
  language,
  modified,
  original,
}: InlineDiffViewProps) {
  const themeKey = `inline-diff-${language}`;
  const initializedRef = useRef(false);

  const handleMount = useCallback<DiffOnMount>(
    (_editor, monacoInstance) => {
      if (!initializedRef.current) {
        monacoInstance.editor.defineTheme(themeKey, INLINE_DIFF_THEME);
        initializedRef.current = true;
      }
      monacoInstance.editor.setTheme(themeKey);
    },
    [themeKey]
  );

  return (
    <div className="flex flex-col" style={{ height }}>
      <div className="flex items-center gap-3 border-white/5 border-b px-3 py-1.5">
        <span className="text-[0.6rem] text-red-400/70">
          <span className="mr-1">−</span>Original
        </span>
        <span className="text-[0.6rem] text-emerald-400/70">
          <span className="mr-1">+</span>Modified
        </span>
      </div>
      <div className="flex-1">
        <DiffEditor
          height="100%"
          language={language}
          modified={modified}
          onMount={handleMount}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily:
              "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            useInlineViewWhenSpaceIsLimited: false,
            lineNumbers: "off",
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 0,
          }}
          original={original}
          theme={themeKey}
        />
      </div>
    </div>
  );
}
